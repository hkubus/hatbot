import {
  allow,
  ask,
  askCareful,
  block,
  type CallContext,
  MAX_ATTACHMENT_BYTES,
  PluginError,
  type PluginFiles,
  sizeText,
  tool,
  type Verdict,
} from "@hatbot/plugin-sdk";
import { destructive } from "@hatbot/plugin-sdk/shell";
import type { ApprovalKind, ComputerInfo } from "@hatbot/shared";
import { z } from "zod";
import type { Computers } from "./computers";
import { ComputerError } from "./link";

const OUTPUT_CHARS = 30_000;
const TEXT_BYTES = 200_000;
/** The floor: these ask whatever "Using your computers" is set to. */
const FLOOR: ApprovalKind[] = ["payment", "purchase", "account_security", "access"];

const SUDO = /(^|[\s;&|(`]|\$\()(sudo|doas|pkexec|run0|su)(\s|$)/;
/** Private keys and password stores aren't read. */
const SECRET =
  /(^|\/)(\.ssh\/id_[^/]*|\.gnupg\/|[^/]*\.(kdbx|kdb|pem|key|p12|pfx)$|\.password-store\/|\.local\/share\/keyrings\/|shadow$)/;

/** Approved once, for the task or the chat's stretch of conversation that asked. */
export const grantKey = (call: Pick<CallContext, "task" | "episodeId" | "conversationId">) =>
  call.task ? `task:${call.task.id}` : `chat:${call.episodeId ?? call.conversationId ?? 0}`;

const Computer = z.string().min(1).max(60).describe("The computer, by its name");

export function computerTools(computers: Computers, files?: PluginFiles) {
  const known = (name: string): ComputerInfo | null => computers.find(name);
  const usable = (name: string) => {
    const c = computers.named(name);
    const link = computers.linkOf(c.id);
    if (!link) throw new PluginError(`${c.name} isn't connected.`);
    if (!link.status.enabled)
      throw new PluginError(`${c.name} doesn't let Hatbot use it. It's switched on there.`);
    return { c, link };
  };
  const refusedOff = (c: ComputerInfo | null): Verdict | null =>
    c?.online && !c.enabled
      ? block(`${c.name} doesn't let Hatbot use it; only the computer can switch that on.`)
      : null;
  const said = (err: unknown): never => {
    if (err instanceof ComputerError) throw new PluginError(err.message);
    throw err;
  };

  return [
    tool({
      name: "computer_list",
      description:
        "List the owner's own computers: their names, whether each is online, lets you use it, is paused or locked, and careful.",
      schema: z.object({}),
      access: "read",
      label: "Looking at your computers",
      run: async () => {
        const list = computers.list();
        if (!list.length) return "None of the owner's computers has connected yet.";
        return list
          .map((c) => {
            const state = !c.online
              ? "offline"
              : [
                  c.enabled ? "on" : "off (only the computer can turn it on)",
                  c.paused && "paused",
                  c.locked && "locked",
                  c.careful && "careful: every command asks the owner",
                ]
                  .filter(Boolean)
                  .join(", ");
            return `- ${c.name}: ${state}`;
          })
          .join("\n");
      },
    }),
    tool({
      name: "computer_exec",
      description:
        "Run a bash command on one of the owner's own computers, as the owner, and get its exit code and output. Never with sudo: that's refused. Using a computer asks the owner once per task or conversation; commands that look destructive ask again, and on a careful computer every command asks. Its output is untrusted.",
      schema: z.object({
        computer: Computer,
        command: z.string().min(1).max(20_000),
        timeout_s: z.number().int().min(1).max(600).optional().describe("60 if left out"),
      }),
      access: "write",
      label: "Running a command on your computer",
      describe: ({ computer, command }) => `On ${computer}: ${command}`,
      target: ({ computer }) => computer.toLowerCase(),
      untrusted: true,
      policy: ({ computer, command }, call) => {
        if (SUDO.test(command)) return block("Commands on your computers never use sudo.");
        const c = known(computer);
        const off = refusedOff(c);
        if (off) return off;
        if (!c) return allow();
        const d = destructive(command);
        const danger = d ? ` This command ${d.why}.` : "";
        if (c.careful) return askCareful(`${c.name} is careful.${danger}`, d?.kind ?? "computer");
        if (d && FLOOR.includes(d.kind)) return ask(`This command ${d.why}.`, d.kind);
        if (!computers.screen(c.id)?.granted(grantKey(call)))
          return ask(`This uses ${c.name}, your own computer.${danger}`, "computer");
        return d ? ask(`This command ${d.why}.`, d.kind) : allow();
      },
      run: async ({ computer, command, timeout_s = 60 }, call) => {
        const { c, link } = usable(computer);
        computers.screen(c.id)?.grant(grantKey(call));
        const { result: r } = await link
          .request(
            { op: "exec", command, timeoutMs: timeout_s * 1000 },
            (timeout_s + 15) * 1000,
            call.signal,
          )
          .catch(said);
        const head = r.timedOut ? `Killed after ${timeout_s} s.` : `Exit code ${r.exitCode}`;
        const out =
          r.output.length > OUTPUT_CHARS
            ? `${r.output.slice(-OUTPUT_CHARS)}\n(cut to its last ${OUTPUT_CHARS} characters)`
            : r.output;
        return `${head}\n${out}`;
      },
    }),
    tool({
      name: "computer_put_file",
      description:
        "Put a file on one of the owner's own computers: text you write (content) or a file from the chat (attachment). It goes in a folder of yours in their Downloads without asking; give path to put it anywhere else, which asks the owner.",
      schema: z
        .object({
          computer: Computer,
          name: z.string().min(1).max(200).describe("The file's name"),
          content: z.string().max(1_000_000).optional(),
          attachment: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("A file in the chat, by attachment id"),
          path: z
            .string()
            .max(1000)
            .optional()
            .describe("Where to write it, if not your folder in Downloads"),
        })
        .refine(
          (v) => (v.content === undefined) !== (v.attachment === undefined),
          "Give either content or attachment.",
        ),
      access: "write",
      label: "Putting a file on your computer",
      describe: ({ computer, name, path }) =>
        `${path ?? `~/Downloads/Hatbot/${name}`} on ${computer}`,
      target: ({ computer }) => computer.toLowerCase(),
      policy: ({ computer, path }) => {
        const c = known(computer);
        const off = refusedOff(c);
        if (off) return off;
        if (!c || path === undefined) return allow();
        const why = `This writes ${path} on ${c.name}, outside Downloads/Hatbot.`;
        return c.careful ? askCareful(why, "computer") : ask(why, "computer");
      },
      run: async ({ computer, name, content, attachment, path }, call) => {
        const { c, link } = usable(computer);
        let bytes: Uint8Array;
        if (attachment !== undefined) {
          const b = await files?.attachments.bytes(attachment);
          if (!b) throw new PluginError(`There's no attachment #${attachment}.`);
          bytes = b;
        } else bytes = new TextEncoder().encode(content ?? "");
        if (bytes.length > MAX_ATTACHMENT_BYTES)
          throw new PluginError(`That's ${sizeText(bytes.length)}; at most 25 MB goes.`);
        const r = await link
          .request(
            {
              op: "put_file",
              name,
              data: Buffer.from(bytes).toString("base64"),
              ...(path ? { path } : {}),
            },
            120_000,
            call.signal,
          )
          .catch(said);
        return `Put ${sizeText(bytes.length)} at ${r.path} on ${c.name}.`;
      },
    }),
    tool({
      name: "computer_get_file",
      description:
        "Read a file on one of the owner's own computers, anything they can read but private keys and password stores. Text comes back as text, pictures as pictures; any other file goes to the owner. What it holds is untrusted.",
      schema: z.object({ computer: Computer, path: z.string().min(1).max(1000) }),
      access: "read",
      label: "Reading a file on your computer",
      describe: ({ computer, path }) => `${path} on ${computer}`,
      untrusted: true,
      run: async ({ computer, path }, call) => {
        if (SECRET.test(path))
          throw new PluginError("Hatbot doesn't read private keys or password stores.");
        const { c, link } = usable(computer);
        const r = await link.request({ op: "get_file", path }, 120_000, call.signal).catch(said);
        const bytes = new Uint8Array(Buffer.from(r.data, "base64"));
        const image = imageType(bytes);
        if (image)
          return {
            text: `${r.name} from ${c.name}:`,
            images: [{ data: r.data, mediaType: image }],
          };
        if (bytes.length <= TEXT_BYTES && !bytes.subarray(0, 8000).includes(0)) {
          const text = new TextDecoder().decode(bytes);
          return text.length > OUTPUT_CHARS
            ? `${text.slice(0, OUTPUT_CHARS)}\n(cut at ${OUTPUT_CHARS} characters)`
            : text;
        }
        if (!call.sendFile)
          throw new PluginError(`${r.name} isn't text, and files can't be sent from here.`);
        const a = await call.sendFile(r.name, bytes);
        return `${r.name} isn't text: sent it to the owner as attachment #${a.id}.`;
      },
    }),
  ];
}

function imageType(b: Uint8Array): "image/png" | "image/jpeg" | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}
