import { CheckCircle2, AlertTriangle, XCircle, MinusCircle, Clock } from 'lucide-react';

interface StatusLabelProps {
  status: string;
}

export function StatusLabel({ status }: StatusLabelProps) {
  const norm = status.toLowerCase();

  if (
    norm === 'verified' ||
    norm === 'strong' ||
    norm === 'balanced' ||
    norm === 'completed' ||
    norm === 'confirmed' ||
    norm === 'bibliographic metadata verified' ||
    norm === 'claim supported' ||
    norm === 'source retrieved'
  ) {
    const label = norm === 'verified' ? 'Verified' : norm === 'completed' ? 'Completed' : status;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }

  if (
    norm === 'needs review' ||
    norm === 'needs_review' ||
    norm === 'adequate' ||
    norm === 'needs improvement' ||
    norm === 'uniformity detected' ||
    norm === 'sparse variation' ||
    norm === 'draft' ||
    norm === 'possible' ||
    norm === 'evidence insufficient'
  ) {
    const label = norm === 'needs_review' ? 'Needs review' : norm === 'draft' ? 'Draft' : status;
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 whitespace-nowrap">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>{label}</span>
      </span>
    );
  }

  if (
    norm === 'unverified' ||
    norm === 'missing' ||
    norm === 'high repetition' ||
    norm === 'failed' ||
    norm === 'unsupported' ||
    norm === 'claim contradicted'
  ) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 whitespace-nowrap">
        <XCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span>{status}</span>
      </span>
    );
  }

  if (norm === 'queued' || norm === 'processing') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 whitespace-nowrap">
        <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="capitalize">{status}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 whitespace-nowrap">
      <MinusCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}
