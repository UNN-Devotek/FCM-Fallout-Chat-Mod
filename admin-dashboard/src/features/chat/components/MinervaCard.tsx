import React from 'react';
import { ChatEmbedCard, type ChatEmbedCardProps } from './ChatEmbedCard';

export interface MinervaMetadata {
  type: 'minerva';
  location: string;
  listNumber: number;
  isSuperSale: boolean;
  isActive: boolean;
  startUtc: string;
  endUtc: string;
  nextLocation: string | null;
  nextListNumber: number | null;
  nextIsSuperSale: boolean | null;
  nextStartUtc: string | null;
  sourceName?: string;
  sourceUrl?: string;
  inventory?: string[];
}

type MinervaCardProps = Pick<ChatEmbedCardProps,
  'hexAlpha' | 'fontFamily' | 'fontSize' | 'dimText' | 'onShareToChat' | 'shareDisabled'
> & {
  sale: MinervaMetadata;
  sourceName: string;
  onOpenSource: () => void;
};

function inventoryRows(inventory: string[] = []) {
  // Keep the existing wire format. Only split the known price suffix; names may
  // themselves contain dashes. Unrecognized entries stay visible, sorted last.
  return inventory.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => {
    const match = /^(.*?) — (\d+|\d{1,3}(?:,\d{3})+) Gold$/.exec(entry);
    const amount = match ? Number(match[2].replace(/,/g, '')) : NaN;
    const price = Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
    return { name: price === null ? entry : match![1], price };
  }).sort((a, b) => (b.price ?? -1) - (a.price ?? -1));
}

function formatDate(iso: string | null) {
  const date = new Date(iso ?? '');
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

function countdown(iso: string, isActive: boolean) {
  const diffMs = new Date(iso).getTime() - Date.now();
  const verb = isActive ? 'Leaves' : 'Arrives';
  if (Number.isNaN(diffMs)) return `${verb} at an unknown time`;
  if (diffMs <= 0) return `${isActive ? 'Visit ended' : 'Arrival time reached'}. Run /minerva to refresh.`;
  const totalMins = Math.floor(diffMs / 60000);
  if (totalMins === 0) return `${verb} in less than a minute`;
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  const parts = [days ? `${days}d` : '', hours ? `${hours}h` : '', mins ? `${mins}m` : ''];
  return `${verb} in ${parts.filter(Boolean).join(' ')}`;
}

/** Minerva-specific content inside the shared command-card shell. */
export function MinervaCard({ sale, sourceName, onOpenSource, ...cardProps }: MinervaCardProps) {
  const rows = inventoryRows(Array.isArray(sale.inventory) ? sale.inventory : []);
  return (
    <ChatEmbedCard
      {...cardProps}
      accent="#F1C40F"
      icon="⛟"
      tag=""
      title="Minerva's Big Sale"
      badges={sale.isSuperSale ? ['SUPER SALE'] : undefined}
      inlineMeta={sale.isActive ? 'Here now' : 'Upcoming'}
      footer={
        <div className="fcm-minerva">
          <div className="fcm-minerva__visit">
            <strong className="fcm-minerva__location">{sale.location}</strong>
            <div>{countdown(sale.isActive ? sale.endUtc : sale.startUtc, sale.isActive)}</div>
            <dl className="fcm-minerva__dates">
              <div><dt>Starts</dt><dd>{formatDate(sale.startUtc)}</dd></div>
              <div><dt>Ends</dt><dd>{formatDate(sale.endUtc)}</dd></div>
            </dl>
          </div>
          {rows.length > 0 ? (
            <table className="fcm-minerva__inventory">
              <caption>For sale · Highest price first</caption>
              <colgroup><col /><col className="fcm-minerva__price-column" /></colgroup>
              <thead><tr><th scope="col">Item</th><th scope="col" aria-label="Gold bullion">Gold</th></tr></thead>
              <tbody>
                {rows.map((item, index) => (
                  <tr key={index}>
                    <td>{item.name}</td>
                    <td>{item.price === null ? 'Unknown' : item.price.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="fcm-minerva__unavailable">Inventory unavailable. Run /minerva again to retry.</p>}
          <div className="fcm-minerva__secondary">
            <div>List #{sale.listNumber}</div>
            {sale.isActive && sale.nextLocation && (
              <div>
                Next visit: {sale.nextLocation} · {formatDate(sale.nextStartUtc)}
                {sale.nextListNumber != null ? ` · List #${sale.nextListNumber}` : ''}
                {sale.nextIsSuperSale ? ' · Super Sale' : ''}
              </div>
            )}
          </div>
        </div>
      }
      footerLeft={
        <button type="button" className="fcm-minerva__source" onClick={onOpenSource}>
          via {sourceName} ↗
        </button>
      }
    />
  );
}
