export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function formatCost(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return "";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function usageLabel(usage: { input?: number; output?: number; total?: number; cost?: number } | null): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.input !== undefined) parts.push(`${formatNumber(usage.input)} in`);
  if (usage.output !== undefined) parts.push(`${formatNumber(usage.output)} out`);
  if (usage.cost) parts.push(formatCost(usage.cost));
  return parts.join(" · ");
}
