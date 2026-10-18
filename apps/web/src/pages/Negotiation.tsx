// A negotiation's page (PLAN.md §16.5): its mandate, what's been said, and every message with the seller.
import { type NegotiationMessage, OPEN_NEGOTIATION_STATUSES } from "@hatbot/shared";
import { useCallback, useEffect, useState } from "react";
import { useAction } from "../action";
import { ApiError, api } from "../api";
import { ask } from "../confirm";
import { LoadError, loadErrorText } from "../load";
import { money, NegotiationChip, negotiationText } from "../negotiations";
import { navigate } from "../router";
import { botName, loadNegotiation, useStore } from "../store";
import { ApprovalCard } from "../tasks";
import { BackHead } from "../ui";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const when = (iso: string) =>
  new Date(iso).toDateString() === new Date().toDateString()
    ? time(iso)
    : new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

const OUT: Partial<Record<NegotiationMessage["status"], string>> = {
  sending: "Sending…",
  unconfirmed: "Send was clicked, but the message box didn't clear.",
  failed: "Not sent.",
};

export function NegotiationPage({ id }: { id: number }) {
  const n = useStore((s) => s.negotiations[id]);
  const messages = useStore((s) => s.negotiationMessages[id]);
  const bot = useStore((s) => (n ? botName(s, n.botId) : ""));
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const { busy, error, run } = useAction();

  const load = useCallback(() => {
    setLoadError("");
    loadNegotiation(id).catch((err) => {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setLoadError(loadErrorText(err));
    });
  }, [id]);
  useEffect(load, [load]);

  if (missing) return <div className="empty">This negotiation doesn't exist.</div>;
  if (!n || !messages)
    return (
      <section className="view">
        {loadError && (
          <div className="page narrow">
            <LoadError error={loadError} retry={load} />
          </div>
        )}
      </section>
    );

  const m = n.mandate;
  const a = n.appraisal;
  const c = n.claims;
  const said = c.max !== null || c.otherOffers || c.timing || c.other.length > 0;

  // Abandons it: nothing more goes to the seller, and its tasks stop.
  const stop = async () => {
    if (
      !(await ask({ text: "Stop this negotiation? Nothing more goes to the seller.", ok: "Stop" }))
    )
      return;
    await run(async () => {
      await api(`/negotiations/${id}/close`, { body: {} });
      await loadNegotiation(id);
    });
  };
  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/tasks" label="Tasks">
          {n.conversationUrl && (
            <a
              className="btn sm"
              href={n.conversationUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Conversation
            </a>
          )}
          {OPEN_NEGOTIATION_STATUSES.includes(n.status) && (
            <button type="button" className="btn sm danger-text" disabled={busy} onClick={stop}>
              Stop
            </button>
          )}
        </BackHead>
        {error && <div className="form-error">{error}</div>}

        {n.approvalId !== null && <ApprovalCard approvalId={n.approvalId} showDetails={false} />}

        <div className="panel">
          <div className="task-head">
            <h2>
              <a href={n.listingUrl} target="_blank" rel="noreferrer noopener">
                {n.title}
              </a>
            </h2>
            <NegotiationChip status={n.status} />
          </div>
          <p className="task-summary">{negotiationText(n)}</p>
          <dl className="kv">
            <dt>Want</dt>
            <dd>{n.want}</dd>
            <dt>Bot</dt>
            <dd>{bot}</dd>
            <dt>Asking</dt>
            <dd className="tnum">{n.asking !== null ? money(n.asking, m.currency) : "Unknown"}</dd>
            <dt>Opening offer</dt>
            <dd className="tnum">{money(m.opening, m.currency)}</dd>
            <dt>Target</dt>
            <dd className="tnum">{money(m.target, m.currency)}</dd>
            <dt>{n.role === "buy" ? "Pay at most" : "Take at least"}</dt>
            <dd className="tnum">{money(m.limit, m.currency)}</dd>
            <dt>Delivery</dt>
            <dd>{m.delivery}</dd>
            <dt>Until</dt>
            <dd>
              {new Date(m.expiresAt).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
              })}
            </dd>
            <dt>Contact details</dt>
            <dd>{m.allow.length ? m.allow.join(", ") : "None"}</dd>
            {a && (
              <>
                <dt>Scout</dt>
                <dd>
                  Aim for {money(a.target, a.currency)}, walk away{" "}
                  {n.role === "buy" ? "above" : "below"} {money(a.walkAway, a.currency)}. {a.basis}
                </dd>
              </>
            )}
            {said && (
              <>
                <dt>Said so far</dt>
                <dd>
                  {[
                    c.max !== null &&
                      `${n.role === "buy" ? "Pays at most" : "Takes at least"} ${money(c.max, m.currency)}`,
                    c.otherOffers && `Other offers: ${c.otherOffers}`,
                    c.timing && `Timing: ${c.timing}`,
                    ...c.other,
                  ]
                    .filter(Boolean)
                    .join(". ")}
                </dd>
              </>
            )}
          </dl>
        </div>

        <div className="panel">
          <h3 className="section-title">Messages</h3>
          {!messages.length ? (
            <div className="muted">None yet.</div>
          ) : (
            <ol className="timeline">
              {messages.map((x) => (
                <li
                  key={x.id}
                  className={`tl-step no-icon ${x.status === "failed" ? "tl-error" : ""}`}
                >
                  <span className="t">{when(x.sentAt ?? x.createdAt)}</span>
                  <div className="tl-text">
                    <div>
                      <b>{x.direction === "in" ? "Seller" : bot}</b> {x.text}
                    </div>
                    {OUT[x.status] && (
                      <div className="muted">
                        {OUT[x.status]}{" "}
                        {x.taskId && (
                          <button
                            type="button"
                            className="text-link"
                            onClick={() => navigate(`/tasks/${x.taskId}`)}
                          >
                            Task
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
