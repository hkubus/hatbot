// Settings → Check everything: tries each part Hatbot depends on, and a test approval for the phone.
import type { Approval, CheckReport, CheckState, ChecksInfo } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Icon } from "../icons";
import { navigate } from "../router";
import { useStore } from "../store";

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Couldn't reach Hatbot.";

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
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<ChecksInfo>("/checks").then(
      (info) => {
        setReport(info.report);
        setApproval(info.approval);
        setApprovalId(info.approval?.id ?? null);
      },
      (err) => setError(errorText(err)),
    );
  }, []);

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      setReport(await api<CheckReport>("/checks", { body: {} }));
    } catch (err) {
      setError(errorText(err));
    }
    setRunning(false);
  };

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
        <div className="page-head">
          <button type="button" className="btn sm ghost back" onClick={() => navigate("/settings")}>
            <Icon name="chevron" />
            Settings
          </button>
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={running} onClick={run}>
            {running ? "Checking…" : report ? "Check again" : "Check everything"}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}

        {report && (
          <section className="group">
            <h2>{problems.length ? `${problems.length} to look at` : "All good"}</h2>
            <div className="group-box">
              {[...report.results]
                .sort((a, b) => rank(a.state) - rank(b.state))
                .map((r) => (
                  <div className="row" key={r.id}>
                    <div className="txt">
                      <b>{r.name}</b>
                      <span>{r.detail}</span>
                    </div>
                    <span className={CHIP[r.state].className}>{CHIP[r.state].label}</span>
                  </div>
                ))}
            </div>
          </section>
        )}

        <section className="group">
          <h2>From your phone</h2>
          <div className="group-box">
            <div className="row">
              <div className="txt">
                <b>Test approval</b>
                {shown && (
                  <span>
                    {ANSWER[shown.status]}
                    {shown.decidedVia === "ntfy" ? " from the notification" : ""}
                    {shown.decidedAt ? `, ${when(shown.decidedAt)}` : ""}
                  </span>
                )}
              </div>
              <button type="button" className="btn sm" onClick={tryApproval}>
                Send
              </button>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

const rank = (s: CheckState) => ({ fail: 0, warn: 1, ok: 2, skip: 3 })[s];
