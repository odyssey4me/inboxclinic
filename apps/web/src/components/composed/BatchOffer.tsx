import { Button } from "../ui/Button";

export interface BatchOfferProps {
  domain: string;
  batchSize: number;
  onReviewAsGroup: () => void;
}

/** Discovery batch offer: decide a whole domain at once, or continue individually. */
export function BatchOffer({ domain, batchSize, onReviewAsGroup }: BatchOfferProps) {
  if (batchSize < 2) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-blue-50 px-3 py-2 text-sm">
      <p className="text-blue-900">
        {batchSize} senders from <span className="font-medium">{domain}</span> — review as a group?
      </p>
      <Button variant="secondary" onClick={onReviewAsGroup}>
        Decide for the whole domain
      </Button>
    </div>
  );
}
