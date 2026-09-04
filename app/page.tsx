'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { money } from '@/lib/money';

// My policy IDs all start with POL-, which adds nothing on screen and was
// making the citations column wide enough to push the buttons off the edge.
const shortCode = (id: string) => id.replace(/^POL-/, '');

type Sort = { key: string; dir: 'asc' | 'desc' };

// Sorting is client-side. Each tab keeps its own sort so that sorting the
// Decided tab by outcome does not quietly re-sort the review queue by a
// column that is not even shown there.
function sortRows(rows: any[], sort: Sort) {
  return [...rows].sort((a, b) => {
    let cmp: number;
    // Amounts are bigint, which arrives in JavaScript as a string.
    // Comparing them as text would put "9" after "10", so I convert to
    // numbers first. Same class of trap as storing money as a float.
    if (sort.key === 'amount_cents') {
      cmp = Number(a.amount_cents) - Number(b.amount_cents);
    } else {
      cmp = String(a[sort.key] ?? '').localeCompare(String(b[sort.key] ?? ''));
    }
    return sort.dir === 'asc' ? cmp : -cmp;
  });
}

export default function Console() {
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);

  const [reviewSort, setReviewSort] = useState<Sort>({ key: 'order_id', dir: 'asc' });
  const [settledSort, setSettledSort] = useState<Sort>({ key: 'order_id', dir: 'asc' });

  // cache: 'no-store' matters here. Without it the browser served the
  // previous response and the screen never updated after an approval.
  const load = () =>
    fetch('/api/console', { cache: 'no-store' })
      .then(r => r.json())
      .then(setData);

  useEffect(() => { load(); }, []);

  async function decide(id: number, action: string) {
    setBusy(true);
    await fetch('/api/console/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    await load();
    setBusy(false);
  }

  async function runPending() {
    setBusy(true);
    await fetch('/api/workflow/tick?limit=25', { method: 'POST' });
    await load();
    setBusy(false);
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10 text-sm text-muted-foreground">
        Loading the queue…
      </main>
    );
  }

  const recon = (data.reconciliation ?? []).filter((o: any) =>
    filter === 'all' ? true : Number(o.balance_cents) !== 0
  );

  // I guard with ?? [] because my console API did not originally return
  // this key, and one missing field took the whole page down. A single
  // absent key should never blank the screen.
  const stepsFor = (id: number) =>
    (data.steps ?? []).filter((s: any) => Number(s.refund_id) === Number(id));

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">

      {/* Header. The stats used to be four large cards that pushed the
          actual work below the fold; they are one line of type now. */}
      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b pb-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Refund triage</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <Stat n={data.counts.in_review} label="waiting on review" />
            <Dot />
            <Stat n={data.counts.refunded} label="refunded" />
            <Dot />
            {/* The one place I let colour shout. If this is ever non-zero
                something has gone badly wrong and it should be obvious. */}
            <Stat
              n={data.counts.mismatches}
              label="over-refunded"
              alert={data.counts.mismatches > 0}
            />
            <Dot />
            <Stat n={data.counts.dead} label="discarded events" />
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={runPending} disabled={busy}>
          {busy ? 'Working…' : 'Run pending workflows'}
        </Button>
      </header>

      {/* flex-col here is deliberate: without it my shadcn version laid the
          tab strip out beside the table instead of above it. */}
      <Tabs defaultValue="review" className="mt-6 flex w-full flex-col gap-3">
        <TabsList className="w-fit">
          <TabsTrigger value="review" className="px-4 text-sm">Review queue</TabsTrigger>
          <TabsTrigger value="settled" className="px-4 text-sm">Decided</TabsTrigger>
          <TabsTrigger value="recon" className="px-4 text-sm">Reconciliation</TabsTrigger>
          <TabsTrigger value="discarded" className="px-4 text-sm">Discarded events</TabsTrigger>
        </TabsList>

        {/* ---------------- REVIEW QUEUE ---------------- */}
        <TabsContent value="review" className="w-full space-y-2">
          <SortBar
            sort={reviewSort}
            setSort={setReviewSort}
            columns={[
              ['order_id', 'Order'],
              ['amount_cents', 'Amount'],
              ['reason', 'Reason'],
            ]}
          />

          <Card className="w-full overflow-hidden py-0">
            <Table className="w-full table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[100px]">
                    <SortHead label="Order" sortKey="order_id"
                              sort={reviewSort} setSort={setReviewSort} />
                  </TableHead>
                  <TableHead className="w-[100px] text-right">
                    <SortHead label="Amount" sortKey="amount_cents"
                              sort={reviewSort} setSort={setReviewSort} className="ml-auto" />
                  </TableHead>
                  <TableHead className="w-[110px]">
                    <SortHead label="Reason" sortKey="reason"
                              sort={reviewSort} setSort={setReviewSort} />
                  </TableHead>
                  <TableHead className="w-[150px]">Recommendation</TableHead>
                  <TableHead className="w-[180px]">Policies cited</TableHead>
                  <TableHead className="w-[230px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.review.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="py-14 text-center text-sm text-muted-foreground">
                      Queue is clear. Nothing needs a decision right now.
                    </TableCell>
                  </TableRow>
                )}

                {sortRows(data.review, reviewSort).map((r: any) => (
                  <TableRow key={r.id} className="align-top">
                    <TableCell className="num text-[13px]">{r.order_id}</TableCell>
                    <TableCell className="num text-right text-[13px] font-medium">
                      {money(r.amount_cents, r.currency)}
                    </TableCell>
                    <TableCell className="truncate text-[13px] text-muted-foreground">
                      {r.reason ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Recommendation
                        action={r.model_action}
                        confidence={r.model_confidence}
                      />
                    </TableCell>
                    <TableCell className="overflow-hidden">
                      {/* min-w-0 plus overflow-hidden is what keeps these
                          badges inside their column instead of spilling
                          across the buttons next to them. */}
                      <div className="flex min-w-0 flex-wrap gap-1">
                        {(r.cited_policies ?? []).map((p: string) => (
                          <Badge
                            key={p}
                            variant="outline"
                            className="num max-w-full truncate rounded px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
                          >
                            {shortCode(p)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1.5 whitespace-nowrap">
                        <Dialog>
                          <DialogTrigger className="h-7 shrink-0 rounded-md border px-2.5 text-xs hover:bg-accent">
                            Details
                          </DialogTrigger>
                          <DialogContent className="max-h-[85vh] max-w-2xl space-y-4 overflow-y-auto">
                            <DialogHeader>
                              <DialogTitle className="num text-base">
                                {r.order_id}
                              </DialogTitle>
                            </DialogHeader>

                            <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-md border bg-border text-sm sm:grid-cols-3">
                              <Figure label="Charged" value={money(r.captured_cents, r.currency)} />
                              <Figure label="Refunded so far" value={money(r.refunded_cents, r.currency)} />
                              <Figure label="This request" value={money(r.amount_cents, r.currency)} />
                            </dl>

                            <section>
                              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
                                Why the model said {r.model_action}
                              </h3>
                              {/* break-words is what stops long reasoning
                                  running off the right edge of the dialog. */}
                              <p className="text-sm leading-relaxed break-words">
                                {r.model_reasoning}
                              </p>
                            </section>

                            <section>
                              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
                                Policies it relied on
                              </h3>
                              <div className="flex flex-wrap gap-1">
                                {(r.cited_policies ?? []).map((p: string) => (
                                  <Badge key={p} variant="outline" className="num text-[11px] font-normal">
                                    {p}
                                  </Badge>
                                ))}
                              </div>
                            </section>

                            <section>
                              <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">
                                Workflow trace
                              </h3>
                              <div className="divide-y rounded-md border">
                                {stepsFor(r.id).length === 0 && (
                                  <p className="px-3 py-2 text-xs text-muted-foreground">
                                    No steps recorded yet.
                                  </p>
                                )}
                                {stepsFor(r.id).map((s: any, i: number) => (
                                  <div key={i} className="flex items-center gap-3 px-3 py-2 text-xs">
                                    <span className="num w-36 shrink-0">{s.step}</span>
                                    <span
                                      className={
                                        s.status === 'ok'
                                          ? 'shrink-0 text-green-700'
                                          : 'shrink-0 text-destructive'
                                      }
                                    >
                                      {s.status}
                                    </span>
                                    <span className="num shrink-0 text-muted-foreground">
                                      {s.attempts > 1 ? `${s.attempts} attempts` : '1 attempt'}
                                    </span>
                                    <span className="num truncate text-muted-foreground">
                                      {s.detail}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            </section>
                          </DialogContent>
                        </Dialog>

                        <Button size="sm" className="h-7 shrink-0 px-2.5 text-xs"
                                disabled={busy} onClick={() => decide(r.id, 'approve')}>
                          Approve
                        </Button>
                        <Button size="sm" variant="outline"
                                className="h-7 shrink-0 px-2.5 text-xs text-destructive hover:bg-destructive/5"
                                disabled={busy} onClick={() => decide(r.id, 'reject')}>
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ---------------- DECIDED ---------------- */}
        <TabsContent value="settled" className="w-full space-y-2">
          <SortBar
            sort={settledSort}
            setSort={setSettledSort}
            columns={[
              ['order_id', 'Order'],
              ['amount_cents', 'Amount'],
              ['status', 'Outcome'],
            ]}
          />

          <Card className="w-full overflow-hidden py-0">
            <Table className="w-full table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[110px]">
                    <SortHead label="Order" sortKey="order_id"
                              sort={settledSort} setSort={setSettledSort} />
                  </TableHead>
                  <TableHead className="w-[110px] text-right">
                    <SortHead label="Amount" sortKey="amount_cents"
                              sort={settledSort} setSort={setSettledSort} className="ml-auto" />
                  </TableHead>
                  <TableHead className="w-[120px]">Reason</TableHead>
                  <TableHead className="w-[140px]">
                    <SortHead label="Outcome" sortKey="status"
                              sort={settledSort} setSort={setSettledSort} />
                  </TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data.settled ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-14 text-center text-sm text-muted-foreground">
                      Nothing decided yet. Approved and rejected refunds appear here.
                    </TableCell>
                  </TableRow>
                )}
                {sortRows(data.settled ?? [], settledSort).map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="num text-[13px]">{r.order_id}</TableCell>
                    <TableCell className="num text-right text-[13px]">
                      {money(r.amount_cents, r.currency)}
                    </TableCell>
                    <TableCell className="truncate text-[13px] text-muted-foreground">
                      {r.reason ?? '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Outcome status={r.status} />
                    </TableCell>
                    <TableCell className="text-[13px] text-muted-foreground">
                      {/* A refund that was paid but whose notification
                          permanently failed is a real state my system can
                          reach. Before this tab existed it was invisible. */}
                      {r.status === 'refunded' && r.notify_state === 'failed'
                        ? 'Paid, but the customer notification never sent'
                        : r.status === 'given_up'
                        ? 'The order for this refund never arrived'
                        : ''}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ---------------- RECONCILIATION ---------------- */}
        <TabsContent value="recon" className="w-full space-y-3">
          <Select value={filter} onValueChange={(v) => setFilter(v ?? 'all')}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All refunded orders</SelectItem>
              <SelectItem value="open">Only orders not fully settled</SelectItem>
            </SelectContent>
          </Select>

          <Card className="w-full overflow-hidden py-0">
            <Table className="w-full table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[140px]">Order</TableHead>
                  <TableHead className="text-right">Charged</TableHead>
                  <TableHead className="text-right">Refunded</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="w-[170px] text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recon.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-14 text-center text-sm text-muted-foreground">
                      No orders match this filter.
                    </TableCell>
                  </TableRow>
                )}
                {recon.map((o: any) => {
                  const balance = Number(o.balance_cents);
                  return (
                    <TableRow key={o.order_id}>
                      <TableCell className="num text-[13px]">{o.order_id}</TableCell>
                      <TableCell className="num text-right text-[13px]">
                        {money(o.captured_cents, o.currency)}
                      </TableCell>
                      <TableCell className="num text-right text-[13px]">
                        {money(o.refunded_cents, o.currency)}
                      </TableCell>
                      <TableCell
                        className={`num text-right text-[13px] font-medium ${
                          balance < 0 ? 'text-destructive' : ''
                        }`}
                      >
                        {money(o.balance_cents, o.currency)}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {balance < 0 ? (
                          <Badge variant="destructive" className="text-[11px]">
                            over-refunded
                          </Badge>
                        ) : balance === 0 ? (
                          <span className="text-[13px] text-green-700">fully refunded</span>
                        ) : (
                          <span className="text-[13px] text-muted-foreground">partly refunded</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>

        {/* ---------------- DISCARDED EVENTS ---------------- */}
        <TabsContent value="discarded" className="w-full">
          <Card className="w-full overflow-hidden py-0">
            <Table className="w-full table-fixed">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[160px]">Event</TableHead>
                  <TableHead>Why it was discarded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data.discarded ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={2} className="py-14 text-center text-sm text-muted-foreground">
                      Every event so far has been processed.
                    </TableCell>
                  </TableRow>
                )}
                {(data.discarded ?? []).map((e: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="num text-[13px]">{e.event_id ?? '—'}</TableCell>
                    <TableCell className="text-[13px] text-muted-foreground">
                      {e.reason}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </main>
  );
}

/* ---------- small pieces ---------- */

// Two ways to sort, because they suit different habits: this dropdown pair
// says out loud what is possible, and clicking a column header is faster
// once you know. Both drive the same state.
function SortBar({
  sort, setSort, columns,
}: {
  sort: Sort;
  setSort: (s: Sort) => void;
  columns: [string, string][];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Sort by</span>

      <Select value={sort.key} onValueChange={(v) => setSort({ ...sort, key: v ?? 'order_id' })}>
        <SelectTrigger className="h-8 w-40 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {columns.map(([key, label]) => (
            <SelectItem key={key} value={key}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={sort.dir}
        onValueChange={(v) => setSort({ ...sort, dir: (v as 'asc' | 'desc') ?? 'asc' })}
      >
        <SelectTrigger className="h-8 w-36 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="asc">Ascending</SelectItem>
          <SelectItem value="desc">Descending</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function SortHead({
  label, sortKey, sort, setSort, className = '',
}: {
  label: string;
  sortKey: string;
  sort: Sort;
  setSort: (s: Sort) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      onClick={() =>
        setSort({
          key: sortKey,
          // Clicking the same column flips direction; a new column starts
          // ascending, which is what people expect.
          dir: active && sort.dir === 'asc' ? 'desc' : 'asc',
        })
      }
      className={`flex items-center gap-1 hover:text-foreground ${
        active ? 'text-foreground' : ''
      } ${className}`}
    >
      {label}
      <span aria-hidden className="text-[10px] text-muted-foreground">
        {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </button>
  );
}

function Stat({ n, label, alert = false }: { n: number; label: string; alert?: boolean }) {
  return (
    <span className={alert ? 'font-medium text-destructive' : ''}>
      <span className="num">{n}</span> {label}
    </span>
  );
}

function Dot() {
  return <span aria-hidden className="text-border">·</span>;
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-3 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="num mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

function Recommendation({ action, confidence }: { action: string; confidence: number }) {
  // A dot plus plain text reads faster than a filled pill, and it stops
  // every row shouting at the agent with equal weight.
  const colour =
    action === 'approve' ? 'bg-green-600'
    : action === 'reject' ? 'bg-red-600'
    : 'bg-amber-500';

  return (
    <span className="flex items-center gap-2 text-[13px]">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colour}`} />
      <span>{action}</span>
      <span className={`num text-xs ${confidence >= 70 ? 'text-muted-foreground' : 'text-amber-700'}`}>
        {confidence > 0 ? `${confidence}%` : 'unscored'}
      </span>
    </span>
  );
}

function Outcome({ status }: { status: string }) {
  const label =
    status === 'refunded' ? 'refunded'
    : status === 'rejected' ? 'rejected'
    : 'given up';
  const colour =
    status === 'refunded' ? 'bg-green-600'
    : status === 'rejected' ? 'bg-red-600'
    : 'bg-stone-400';

  return (
    <span className="flex items-center gap-2 text-[13px]">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colour}`} />
      <span>{label}</span>
    </span>
  );
}