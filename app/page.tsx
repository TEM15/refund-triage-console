'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

export default function Console() {
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(false);

  const load = () => fetch('/api/console').then(r => r.json()).then(setData);

  useEffect(() => { load(); }, []);

  async function decide(id: number, action: string) {
    setBusy(true);
    await fetch('/api/console/decide', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, action }),
    });
    await load();   // refresh the screen so the row disappears
    setBusy(false);
  }

  // A button that drains the queue, so I can demo the workflow live
  // without opening a terminal.
  async function tick() {
    setBusy(true);
    await fetch('/api/workflow/tick?limit=25', { method: 'POST' });
    await load();
    setBusy(false);
  }

  if (!data) return <div className="p-6 text-sm">Loading…</div>;

  const rows = data.reconciliation.filter((o: any) =>
    filter === 'all' ? true : Number(o.balance_cents) !== 0
  );

  // I group the trace rows by refund so each dialog can show its own.
  const traceFor = (id: number) =>
    data.traces.filter((t: any) => String(t.refund_id) === String(id));

  return (
    <main className="p-6 space-y-4 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Refund Triage Console</h1>
        <Button size="sm" variant="outline" onClick={tick} disabled={busy}>
          {busy ? 'Working…' : 'Run pending workflows'}
        </Button>
      </div>

      {/* ---------- Counts across the top ---------- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['Waiting on review', data.counts.in_review],
          ['Refunded', data.counts.refunded],
          ['Over-refunded orders', data.counts.mismatches],
          ['Rejected events', data.counts.dead],
        ].map(([label, value]: any) => (
          <Card key={label}>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs font-normal text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-mono pt-0">{value}</CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="review">
        <TabsList>
          <TabsTrigger value="review">Review queue</TabsTrigger>
          <TabsTrigger value="recon">Reconciliation</TabsTrigger>
          <TabsTrigger value="rejected">Rejected events</TabsTrigger>
        </TabsList>

        {/* ================= REVIEW QUEUE ================= */}
        <TabsContent value="review">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Model says</TableHead>
                <TableHead>Confidence</TableHead>
                <TableHead>Citations</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.review.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground text-sm">
                    Nothing waiting for review.
                  </TableCell>
                </TableRow>
              )}
              {data.review.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.order_id}</TableCell>
                  <TableCell className="font-mono">
                    {money(r.amount_cents, r.currency)}
                  </TableCell>
                  <TableCell>{r.reason ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{r.model_action}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.model_confidence >= 70 ? 'default' : 'outline'}>
                      {r.model_confidence}%
                    </Badge>
                  </TableCell>
                  <TableCell className="space-x-1">
                    {(r.cited_policies ?? []).map((p: string) => (
                      <Badge key={p} variant="outline" className="font-mono text-[10px]">
                        {p}
                      </Badge>
                    ))}
                  </TableCell>
                  <TableCell className="text-right space-x-2 whitespace-nowrap">

                    {/* The dialog shows the full reasoning and the trace */}
                    <Dialog>
                  <DialogTrigger className="border rounded-md px-3 py-1.5 text-sm hover:bg-accent">
                      Details
                  </DialogTrigger>
                      <DialogContent className="max-w-lg">
                        <DialogHeader>
                          <DialogTitle className="font-mono">{r.order_id}</DialogTitle>
                        </DialogHeader>

                        <p className="text-xs font-mono text-muted-foreground">
                          charged {money(r.captured_cents, r.currency)} ·
                          refunded so far {money(r.refunded_cents, r.currency)} ·
                          this request {money(r.amount_cents, r.currency)}
                        </p>

                        <div>
                          <p className="text-xs font-semibold mb-1">Model reasoning</p>
                          <p className="text-sm">{r.model_reasoning}</p>
                        </div>

                        <div>
                          <p className="text-xs font-semibold mb-1">Policies cited</p>
                          <div className="space-x-1">
                            {(r.cited_policies ?? []).map((p: string) => (
                              <Badge key={p} variant="outline" className="font-mono text-[10px]">
                                {p}
                              </Badge>
                            ))}
                          </div>
                        </div>

                        <div>
                          <p className="text-xs font-semibold mb-1">Workflow trace</p>
                          <Table>
                            <TableBody>
                              {traceFor(r.id).map((t: any, i: number) => (
                                <TableRow key={i}>
                                  <TableCell className="font-mono text-xs py-1">
                                    {t.step}
                                  </TableCell>
                                  <TableCell className="py-1">
                                    <Badge
                                      variant={t.status === 'ok' ? 'default' : 'destructive'}
                                      className="text-[10px]"
                                    >
                                      {t.status}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="text-xs py-1">
                                    {t.attempts} attempt(s)
                                  </TableCell>
                                  <TableCell className="text-xs py-1 text-muted-foreground">
                                    {t.detail}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </DialogContent>
                    </Dialog>

                    <Button size="sm" disabled={busy}
                            onClick={() => decide(r.id, 'approve')}>
                      Approve
                    </Button>
                    <Button size="sm" variant="destructive" disabled={busy}
                            onClick={() => decide(r.id, 'reject')}>
                      Reject
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        {/* ================= RECONCILIATION ================= */}
        <TabsContent value="recon" className="space-y-3">
          <Select value={filter} onValueChange={(v) => setFilter(v ?? 'all')}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All refunded orders</SelectItem>
              <SelectItem value="open">Only orders not fully settled</SelectItem>
            </SelectContent>
          </Select>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Charged</TableHead>
                <TableHead>Refunded</TableHead>
                <TableHead>Balance</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o: any) => (
                <TableRow key={o.order_id}>
                  <TableCell className="font-mono text-xs">{o.order_id}</TableCell>
                  <TableCell className="font-mono">
                    {money(o.captured_cents, o.currency)}
                  </TableCell>
                  <TableCell className="font-mono">
                    {money(o.refunded_cents, o.currency)}
                  </TableCell>
                  <TableCell className="font-mono">
                    {money(o.balance_cents, o.currency)}
                  </TableCell>
                  <TableCell>
                    {Number(o.balance_cents) < 0
                      ? <Badge variant="destructive">OVER-REFUNDED</Badge>
                      : Number(o.balance_cents) === 0
                        ? <Badge>fully refunded</Badge>
                        : <Badge variant="secondary">partly refunded</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>

        {/* ================= REJECTED EVENTS ================= */}
        <TabsContent value="rejected">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Why it was rejected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rejected.map((e: any, i: number) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{e.event_id ?? '—'}</TableCell>
                  <TableCell className="text-sm">{e.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>
    </main>
  );
}