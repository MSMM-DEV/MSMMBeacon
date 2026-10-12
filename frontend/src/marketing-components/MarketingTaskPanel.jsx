import React, { useState } from "react";
import { Alert, Badge, Button, Field, Input, Textarea } from "@/ui";
import { Icon } from "../icons.jsx";
import { createMarketingTask, createScheduledAlert, updateMarketingTask } from "../data.js";
import { sortMarketingTasks } from "../marketing-model.js";

export function MarketingTaskPanel({ opportunityId, tasks = [], users = [], onChanged, createApi = createMarketingTask, updateApi = updateMarketingTask, now = new Date() }) {
  const [form, setForm] = useState({ title: "", assigneeId: "", dueAt: "", priority: "normal", notes: "", reminderEnabled: false, reminderAt: "", recurrence: "one_time", recipientIds: [] });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [reminderDraft, setReminderDraft] = useState(null);
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const submit = async event => {
    event.preventDefault();
    if (!form.title.trim() || !form.assigneeId) { setError("Task title and assignee are required."); return; }
    if (form.reminderEnabled && !form.reminderAt) { setError("Choose when the reminder should be sent."); return; }
    setSaving(true); setError("");
    try {
      const row = await createApi({ ...form, opportunityId, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null });
      onChanged?.(row, "created");
      if (form.reminderEnabled) {
        const draft = { task: row, firstFireAt: form.reminderAt, recurrence: form.recurrence, recipientUserIds: [...new Set([form.assigneeId, ...form.recipientIds].filter(Boolean))] };
        try { await scheduleReminder(draft); }
        catch { setReminderDraft(draft); setError("Task saved; reminder was not scheduled"); }
      }
      setForm({ title: "", assigneeId: "", dueAt: "", priority: "normal", notes: "", reminderEnabled: false, reminderAt: "", recurrence: "one_time", recipientIds: [] });
    } catch (saveError) { setError(saveError.message || "The task could not be created."); }
    finally { setSaving(false); }
  };
  const scheduleReminder = async draft => {
    const alertId = await createScheduledAlert({ subjectTable: "marketing", subjectRowId: opportunityId, firstFireAt: new Date(draft.firstFireAt).toISOString(), recurrence: draft.recurrence, message: `Task: ${draft.task.title}${draft.task.notes ? `\n${draft.task.notes}` : ""}`, recipientUserIds: draft.recipientUserIds });
    const saved = await updateApi(draft.task.id, { alertId });
    onChanged?.(saved, "updated");
    setReminderDraft(null);
    return saved;
  };
  const retryReminder = async () => {
    if (!reminderDraft) return;
    setSaving(true); setError("");
    try { await scheduleReminder(reminderDraft); }
    catch { setError("Task saved; reminder was not scheduled"); }
    finally { setSaving(false); }
  };
  const toggle = async task => {
    setBusyId(task.id); setError("");
    try { onChanged?.(await updateApi(task.id, { status: task.status === "completed" ? "open" : "completed" }), "updated"); }
    catch (saveError) { setError(saveError.message || "The task could not be updated."); }
    finally { setBusyId(null); }
  };
  const currentTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return (
    <section className="marketing-support-panel">
      <form onSubmit={submit} className="marketing-support-form">
        <h3>Add task</h3>
        {error && <Alert role="alert" tone={reminderDraft ? "warning" : "danger"} title={reminderDraft ? "Reminder needs attention" : "Could not save task"}>{error}{reminderDraft && <Button type="button" size="sm" variant="default" onClick={retryReminder}>Retry reminder</Button>}</Alert>}
        <div className="marketing-form-grid">
          <Field label="Task title" htmlFor="marketing-task-title" required className="marketing-field-wide"><Input id="marketing-task-title" required value={form.title} onChange={event => set("title", event.target.value)}/></Field>
          <Field label="Assignee" htmlFor="marketing-task-assignee" required><select id="marketing-task-assignee" required value={form.assigneeId} onChange={event => set("assigneeId", event.target.value)}><option value="">Choose assignee</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
          <Field label="Due" htmlFor="marketing-task-due"><Input id="marketing-task-due" type="datetime-local" value={form.dueAt} onChange={event => set("dueAt", event.target.value)}/></Field>
          <Field label="Priority" htmlFor="marketing-task-priority"><select id="marketing-task-priority" value={form.priority} onChange={event => set("priority", event.target.value)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></Field>
          <Field label="Notes" htmlFor="marketing-task-notes" className="marketing-field-wide"><Textarea id="marketing-task-notes" value={form.notes} onChange={event => set("notes", event.target.value)}/></Field>
          <label className="marketing-reminder-toggle"><input type="checkbox" checked={form.reminderEnabled} onChange={event => set("reminderEnabled", event.target.checked)}/>Schedule email reminder</label>
          {form.reminderEnabled && <>
            <Field label="Reminder date and time" htmlFor="marketing-reminder-at" required><Input id="marketing-reminder-at" type="datetime-local" required value={form.reminderAt} onChange={event => set("reminderAt", event.target.value)}/></Field>
            <Field label="Recurrence" htmlFor="marketing-reminder-recurrence"><select id="marketing-reminder-recurrence" value={form.recurrence} onChange={event => set("recurrence", event.target.value)}><option value="one_time">One time</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option></select></Field>
            <Field label="Additional recipients" htmlFor="marketing-reminder-recipients"><select id="marketing-reminder-recipients" multiple value={form.recipientIds} onChange={event => set("recipientIds", [...event.target.selectedOptions].map(option => option.value))}>{users.filter(user => user.id !== form.assigneeId).map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
          </>}
        </div>
        <Button type="submit" variant="primary" loading={saving}><Icon name="plus"/>Add task</Button>
      </form>
      <div className="marketing-task-list">
        {sortMarketingTasks(tasks, now).map(task => {
          const overdue = task.status !== "completed" && task.dueAt && new Date(task.dueAt).getTime() < currentTime;
          return <article key={task.id} data-overdue={overdue || undefined}><div><strong>{task.title}</strong><span>{users.find(user => user.id === task.assigneeId)?.name || "Unassigned"}</span></div><div><Badge tone={overdue ? "danger" : task.status === "completed" ? "success" : "neutral"}>{overdue ? "Overdue" : task.status}</Badge><Badge tone="neutral">{task.priority}</Badge></div><p>{task.notes}</p><time>{task.dueAt ? new Date(task.dueAt).toLocaleString() : "No due date"}</time><Button size="sm" variant={task.status === "completed" ? "default" : "success"} onClick={() => toggle(task)} disabled={busyId === task.id}>{task.status === "completed" ? "Reopen" : "Complete"}</Button></article>;
        })}
        {!tasks.length && <p>No tasks yet.</p>}
      </div>
    </section>
  );
}

export default MarketingTaskPanel;
