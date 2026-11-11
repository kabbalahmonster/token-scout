import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, LoaderCircle, RefreshCw } from 'lucide-react';
import { client, type AssessmentQueued } from '../api.js';

export function ReassessButton({ chainId, address, label, onQueued }: { chainId: number; address: string; label: string; onQueued?: (queued: AssessmentQueued) => void }) {
  const cache = useQueryClient();
  const reassess = useMutation({
    mutationFn: () => client.assess(address, chainId),
    onSuccess: async (queued) => {
      onQueued?.(queued);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['jobs'] }),
        cache.invalidateQueries({ queryKey: ['operations'] }),
        cache.invalidateQueries({ queryKey: ['candidates'] }),
        cache.invalidateQueries({ queryKey: ['candidate', chainId, address] })
      ]);
    }
  });
  const name = label || address;
  const text = reassess.isPending
    ? `Queueing ${name} for reassessment`
    : reassess.isSuccess
      ? `${name} queued for reassessment`
      : reassess.isError
        ? `Could not queue ${name}; tap to retry`
        : `Queue ${name} for reassessment`;

  return <span className="reassess-wrap">
    <button className={`reassess${reassess.isSuccess ? ' queued' : ''}${reassess.isError ? ' failed' : ''}`} type="button" aria-label={text} title={text} disabled={reassess.isPending || reassess.isSuccess} onClick={() => reassess.mutate()}>
      {reassess.isPending ? <LoaderCircle className="spin" size={16}/> : reassess.isSuccess ? <Check size={16}/> : reassess.isError ? <AlertTriangle size={16}/> : <RefreshCw size={16}/>}
    </button>
    <span className="reassess-status" role="status">{reassess.isSuccess || reassess.isError ? text : ''}</span>
  </span>;
}
