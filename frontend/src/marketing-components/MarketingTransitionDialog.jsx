import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Button, Dialog, DialogBody, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, SelectContent,
  SelectItem, SelectTrigger, SelectValue, Textarea,
} from "@/ui";
import { Icon } from "../icons.jsx";
import {
  MARKETING_LOSS_REASONS,
  MARKETING_STAGE_NAMES,
  transitionDraft,
  validateMarketingTransition,
} from "../marketing-rules.js";

const TERMINAL_STAGE = MARKETING_STAGE_NAMES.at(-1);

export function MarketingTransitionDialog({ opportunity, toStage, onCancel, onConfirm, saving = false, error = null }) {
  const [form, setForm] = useState(() => transitionDraft(opportunity, toStage));
  const errorRef = useRef(null);
  useEffect(() => { setForm(transitionDraft(opportunity, toStage)); }, [opportunity, toStage]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  const result = useMemo(() => validateMarketingTransition(form), [form]);
  const terminal = toStage === TERMINAL_STAGE;
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  const submit = event => {
    event.preventDefault();
    if (!result.errors.length && !saving) onConfirm?.(result.normalized);
  };

  return (
    <Dialog open={!!opportunity && !!toStage} onOpenChange={open => { if (!open && !saving) onCancel?.(); }}>
      <DialogContent size="lg" aria-describedby="marketing-transition-description">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Move to {toStage}</DialogTitle>
            <DialogDescription id="marketing-transition-description">
              Review the sales evidence before moving {opportunity?.title}. The card moves only after Beacon saves the transition.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="marketing-transition-body">
            {error && <div ref={errorRef} tabIndex={-1}><Alert role="alert" tone="danger" title="The opportunity was not moved">{error}</Alert></div>}
            {!!form.missingFields?.length && (
              <Alert tone="warning" title="Recommended information is still missing" icon={<Icon name="warn"/>}>
                {form.missingFields.join(", ")}. You can continue, but completing it will make the handoff stronger.
              </Alert>
            )}
            <div className="marketing-form-grid">
              <div className="marketing-field">
                <Label htmlFor="marketing-transition-probability">Probability</Label>
                <Input id="marketing-transition-probability" type="number" min="0" max="100" step="1"
                  value={form.probability} onChange={event => set("probability", event.target.value)}/>
                <p>Recommended for this stage: {transitionDraft(opportunity, toStage).probability}%</p>
              </div>
              {terminal && (
                <div className="marketing-field">
                  <Label>Outcome</Label>
                  <Select value={form.outcome || ""} onValueChange={value => set("outcome", value)}>
                    <SelectTrigger aria-label="Contract outcome"><SelectValue placeholder="Choose Won or Lost"/></SelectTrigger>
                    <SelectContent><SelectItem value="won">Won</SelectItem><SelectItem value="lost">Lost</SelectItem></SelectContent>
                  </Select>
                </div>
              )}
              {terminal && form.outcome === "won" && (<>
                <div className="marketing-field">
                  <Label htmlFor="marketing-signed-at">Signature date</Label>
                  <Input id="marketing-signed-at" type="date" value={form.signedAt || ""} onChange={event => set("signedAt", event.target.value)}/>
                </div>
                <div className="marketing-field">
                  <Label htmlFor="marketing-final-value">Final contract value</Label>
                  <Input id="marketing-final-value" type="number" min="0" step="0.01" value={form.finalContractValue ?? ""} onChange={event => set("finalContractValue", event.target.value)}/>
                </div>
              </>)}
              {terminal && form.outcome === "lost" && (<>
                <div className="marketing-field">
                  <Label>Why did we lose?</Label>
                  <Select value={form.lossReason || ""} onValueChange={value => set("lossReason", value)}>
                    <SelectTrigger aria-label="Loss reason"><SelectValue placeholder="Choose a reason"/></SelectTrigger>
                    <SelectContent>{MARKETING_LOSS_REASONS.map(reason => <SelectItem key={reason} value={reason}>{reason}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="marketing-field marketing-field-wide">
                  <Label htmlFor="marketing-loss-detail">What did we learn?</Label>
                  <Textarea id="marketing-loss-detail" value={form.lossDetail || ""} onChange={event => set("lossDetail", event.target.value)}/>
                </div>
              </>)}
              <div className="marketing-field marketing-field-wide">
                <Label htmlFor="marketing-transition-note">Transition note</Label>
                <Textarea id="marketing-transition-note" placeholder="Why is this opportunity ready for this stage?"
                  value={form.transitionNote || ""} onChange={event => set("transitionNote", event.target.value)}/>
              </div>
            </div>
            {!!result.errors.length && (
              <ul className="marketing-form-errors" role="alert">
                {result.errors.map(item => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}
              </ul>
            )}
            {!!result.warnings.length && (
              <ul className="marketing-form-warnings">
                {result.warnings.map(item => <li key={`${item.field}-${item.message}`}>{item.message}</li>)}
              </ul>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="default" onClick={onCancel} disabled={saving}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={saving || result.errors.length > 0} loading={saving}>
              {saving ? "Saving…" : "Confirm move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default MarketingTransitionDialog;
