import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { Job } from "@lambdata/shared";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { databasePath } from "../../lib/commands";
import { jobConflictId, useJob } from "../../lib/jobs";
import { errorMessage } from "../../lib/api";
import { JobProgress } from "./JobProgress";

export interface JobConflictNoticeProps {
  error: unknown;
  onCleared?: (job: Job) => void;
  className?: string;
}

function jobTab(job: Job): string {
  if (job.kind === "sync.run") return "sync";
  if (job.kind === "import.sqlite" || job.kind === "import.sql") return "import";
  return "history";
}

export function JobConflictNotice({ error, onCleared, className }: JobConflictNoticeProps) {
  const jobId = jobConflictId(error);
  const { job, isActive } = useJob(jobId, { onDone: onCleared });
  if (!jobId) return null;
  const blocking = isActive || !job;
  return (
    <Alert
      variant={blocking ? "warning" : "neutral"}
      title={blocking ? errorMessage(error) : "The other operation has finished"}
      className={className}
      action={
        job?.databaseId ? (
          <Button size="xs" variant="secondary" asChild>
            <Link to={databasePath(job.databaseId, jobTab(job))}>
              Open <ArrowRight />
            </Link>
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {!blocking && <p>You can try again now.</p>}
        <JobProgress job={job} variant="compact" />
      </div>
    </Alert>
  );
}
