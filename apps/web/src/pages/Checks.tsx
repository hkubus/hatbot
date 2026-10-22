import type { CheckReport, CheckState, ChecksInfo } from "@hatbot/shared";
import { useEffect, useState } from "react";
import { useAction } from "../action";
import { api, errorText } from "../api";
import { Icon } from "../icons";
import { BackHead, Group, Row } from "../ui";

const CHIP: Record<CheckState, { label: string; className: string }> = {
  ok: { label: "OK", className: "status ok" },
  warn: { label: "Warning", className: "status warn" },
  fail: { label: "Failed", className: "status bad" },
  skip: { label: "Skipped", className: "status" },
};

export function Checks() {
  const [report, setReport] = useState<CheckReport | null>(null);
  const { busy: running, error, setError, run } = useAction();

  useEffect(() => {
    api<ChecksInfo>("/checks").then(
      (info) => setReport(info.report),
      (err) => setError(errorText(err)),
    );
  }, [setError]);

  const check = () => run(async () => setReport(await api<CheckReport>("/checks", { body: {} })));

  const problems = report?.results.filter((r) => r.state === "fail" || r.state === "warn") ?? [];

  return (
    <section className="view">
      <div className="page narrow">
        <BackHead to="/settings" label="Settings">
          <button type="button" className="btn sm" disabled={running} onClick={check}>
            <Icon name={report ? "retry" : "play"} />
            {running ? "Checking…" : report ? "Check again" : "Check everything"}
          </button>
        </BackHead>
        {error && <div className="form-error">{error}</div>}

        {report && (
          <Group title={problems.length ? `${problems.length} to look at` : "All good"}>
            {[...report.results]
              .sort((a, b) => rank(a.state) - rank(b.state))
              .map((r) => (
                <Row key={r.id} label={`${r.name}: ${r.detail}`}>
                  <span className={CHIP[r.state].className}>{CHIP[r.state].label}</span>
                </Row>
              ))}
          </Group>
        )}
      </div>
    </section>
  );
}

const rank = (s: CheckState) => ({ fail: 0, warn: 1, ok: 2, skip: 3 })[s];
