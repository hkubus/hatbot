import type { Approval, CheckReport, CheckState, ChecksInfo } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { useStore } from "../store";
import { BackHead, Group, Row } from "../ui";

const CHIP: Record<CheckState, { label: string; className: string }> = {
  ok: { label: "OK", className: "chip ok" },
  warn: { label: "Warning", className: "chip attn" },
  fail: { label: "Failed", className: "chip bad" },
  skip: { label: "Skipped", className: "chip" },
};

const ANSWER: Record<Approval["status"], string> = {
  pending: "Waiting for your answer",
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Replaced",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export function Checks() {
  const [report, setReport] = useState<CheckReport | null>(null);
  const [approvalId, setApprovalId] = useState<number | null>(null);
  const live = useStore((s) => (approvalId ? s.approvals[approvalId] : undefined));
  const [approval, setApproval] = useState<Approval | null>(null);
  const { busy: running, error, setError, run } = useAction();

  useEffect(() => {
    api<ChecksInfo>("/checks").then(
      (info) => {
        setReport(info.report);
        setApproval(info.approval);
        setApprovalId(info.approval?.id ?? null);
      },
      (err) => setError(errorText(err)),
    );
  }, [setError]);

  const check = () => run(async () => setReport(await api<CheckReport>("/checks", { body: {} })));

  const tryApproval = async () => {
    setError("");
    try {
      const a = await api<Approval>("/checks/approval", { body: {} });
      setApproval(a);
      setApprovalId(a.id);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const shown = live ?? approval;
  const problems = report?.results.filter((r) => r.state === "fail" || r.state === "warn") ?? [];

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings">
          <button type="button" className="btn sm" disabled={running} onClick={check}>
            {running ? "Checking…" : report ? "Check again" : "Check everything"}
          </button>
        </BackHead>
        {error && <div className="form-error">{error}</div>}

        {report && (
          <Group title={problems.length ? `${problems.length} to look at` : "All good"}>
            {[...report.results]
              .sort((a, b) => rank(a.state) - rank(b.state))
              .map((r) => (
                <Row key={r.id} label={r.name} sub={<span>{r.detail}</span>}>
                  <span className={CHIP[r.state].className}>{CHIP[r.state].label}</span>
                </Row>
              ))}
          </Group>
        )}

        <Group title="From your phone">
          <Row
            label="Test approval"
            sub={
              shown && (
                <span>
                  {ANSWER[shown.status]}
                  {shown.decidedVia === "ntfy" ? " from the notification" : ""}
                  {shown.decidedAt ? `, ${when(shown.decidedAt)}` : ""}
                </span>
              )
            }
          >
            <button type="button" className="btn sm" onClick={tryApproval}>
              Send
            </button>
          </Row>
        </Group>
      </div>
    </section>
  );
}

const rank = (s: CheckState) => ({ fail: 0, warn: 1, ok: 2, skip: 3 })[s];
