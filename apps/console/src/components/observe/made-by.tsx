import Link from "next/link";

/**
 * Which agent token made a run, linked to the runs it made. Runs from a session, an app token or
 * a job have no token. A token whose name cannot be read shows the start of its id.
 */
export function MadeBy({ tokenId, tokenName }: { tokenId: string | null; tokenName: string | null }) {
  if (tokenId === null) return <span className="text-bw-text-muted">No token</span>;
  if (tokenName === null) {
    return (
      <span className="font-mono text-xs text-bw-text-muted" title={tokenId}>
        {tokenId.slice(0, 8)}
      </span>
    );
  }
  return (
    <Link href={`/runs?token=${encodeURIComponent(tokenName)}`} className="bw-hit font-medium text-bw-text underline-offset-2 hover:underline" title={`Runs made by ${tokenName}`}>
      {tokenName}
    </Link>
  );
}
