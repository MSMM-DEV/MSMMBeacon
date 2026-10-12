import React, { useState } from "react";
import { Alert, Button, Field, Input, Textarea } from "@/ui";
import { Icon } from "../icons.jsx";
import { createMarketingActivity } from "../data.js";
import { sortMarketingActivities } from "../marketing-model.js";

const ACTIVITY_TYPES = ["Meeting", "Call", "Email", "Demonstration", "Proposal", "Legal update", "Note"];
const nowLocal = () => {
  const date = new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function MarketingActivityPanel({ opportunityId, activities = [], users = [], contacts = [], onCreated, api = createMarketingActivity }) {
  const [form, setForm] = useState({ activityType: "Meeting", occurredAt: nowLocal(), summary: "", userIds: [], contactIds: [], outcome: "", nextStep: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const submit = async event => {
    event.preventDefault();
    if (!form.summary.trim() || !form.occurredAt) { setError("Activity type, occurred date/time, and summary are required."); return; }
    setSaving(true); setError("");
    try {
      const row = await api({ ...form, opportunityId, occurredAt: new Date(form.occurredAt).toISOString() });
      onCreated?.(row);
      setForm({ activityType: "Meeting", occurredAt: nowLocal(), summary: "", userIds: [], contactIds: [], outcome: "", nextStep: "" });
    } catch (saveError) { setError(saveError.message || "The activity could not be logged."); }
    finally { setSaving(false); }
  };
  const names = ids => ids.map(id => users.find(user => user.id === id)?.name || contacts.find(contact => (contact.contactId || contact.id) === id)?.name).filter(Boolean).join(", ");
  return (
    <section className="marketing-support-panel">
      <form onSubmit={submit} className="marketing-support-form">
        <h3>Log activity</h3>
        {error && <Alert role="alert" tone="danger" title="Could not log activity">{error}</Alert>}
        <div className="marketing-form-grid">
          <Field label="Activity type" htmlFor="marketing-activity-type"><select id="marketing-activity-type" value={form.activityType} onChange={event => set("activityType", event.target.value)}>{ACTIVITY_TYPES.map(type => <option key={type}>{type}</option>)}</select></Field>
          <Field label="Occurred" htmlFor="marketing-activity-occurred" required><Input id="marketing-activity-occurred" type="datetime-local" required value={form.occurredAt} onChange={event => set("occurredAt", event.target.value)}/></Field>
          <Field label="Summary" htmlFor="marketing-activity-summary" required className="marketing-field-wide"><Textarea id="marketing-activity-summary" required value={form.summary} onChange={event => set("summary", event.target.value)}/></Field>
          <Field label="Internal participants" htmlFor="marketing-activity-users"><select id="marketing-activity-users" multiple value={form.userIds} onChange={event => set("userIds", [...event.target.selectedOptions].map(option => option.value))}>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
          <Field label="Directory contacts" htmlFor="marketing-activity-contacts"><select id="marketing-activity-contacts" multiple value={form.contactIds} onChange={event => set("contactIds", [...event.target.selectedOptions].map(option => option.value))}>{contacts.map(contact => <option key={contact.contactId || contact.id} value={contact.contactId || contact.id}>{contact.name}</option>)}</select></Field>
          <Field label="Outcome" htmlFor="marketing-activity-outcome" className="marketing-field-wide"><Textarea id="marketing-activity-outcome" value={form.outcome} onChange={event => set("outcome", event.target.value)}/></Field>
          <Field label="Next step" htmlFor="marketing-activity-next" className="marketing-field-wide"><Textarea id="marketing-activity-next" value={form.nextStep} onChange={event => set("nextStep", event.target.value)}/></Field>
        </div>
        <Button type="submit" variant="primary" loading={saving}><Icon name="plus"/>Add activity</Button>
      </form>
      <div className="marketing-timeline" aria-label="Activity timeline">
        {sortMarketingActivities(activities).map(item => (
          <article key={item.id}>
            <span className="marketing-timeline-icon"><Icon name={item.activityType === "Email" ? "mail" : item.activityType === "Call" ? "phone" : "calendar"}/></span>
            <div><header><strong>{item.activityType}</strong><time>{new Date(item.occurredAt).toLocaleString()}</time></header><p>{item.summary}</p>{item.authorId && <small>Logged by {users.find(user => user.id === item.authorId)?.name || "Team member"}</small>}{(item.userIds?.length || item.contactIds?.length) ? <small>With {names([...(item.userIds || []), ...(item.contactIds || [])])}</small> : null}{item.outcome && <p><b>Outcome:</b> {item.outcome}</p>}{item.nextStep && <p><b>Next step:</b> {item.nextStep}</p>}</div>
          </article>
        ))}
        {!activities.length && <p>No activity logged yet.</p>}
      </div>
    </section>
  );
}

export default MarketingActivityPanel;
