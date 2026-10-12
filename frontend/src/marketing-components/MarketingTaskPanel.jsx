import React, { useState } from "react";
import { Alert, Badge, Button, Field, Input, Textarea } from "@/ui";
import { Icon } from "../icons.jsx";
import { createMarketingTask, updateMarketingTask } from "../data.js";
import { sortMarketingTasks } from "../marketing-model.js";

export function MarketingTaskPanel({ opportunityId, tasks = [], users = [], onChanged, createApi = createMarketingTask, updateApi = updateMarketingTask, now = new Date() }) {
  const [form, setForm] = useState({ title: "", assigneeId: "", dueAt: "", priority: "normal", notes: "" });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const submit = async event => {
    event.preventDefault();
    if (!form.title.trim() || !form.assigneeId) { setError("Task title and assignee are required."); return; }
    setSaving(true); setError("");
    try {
      const row = await createApi({ ...form, opportunityId, dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null });
      onChanged?.(row, "created");
      setForm({ title: "", assigneeId: "", dueAt: "", priority: "normal", notes: "" });
    } catch (saveError) { setError(saveError.message || "The task could not be created."); }
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
        {error && <Alert role="alert" tone="danger" title="Could not save task">{error}</Alert>}
        <div className="marketing-form-grid">
          <Field label="Task title" htmlFor="marketing-task-title" required className="marketing-field-wide"><Input id="marketing-task-title" required value={form.title} onChange={event => set("title", event.target.value)}/></Field>
          <Field label="Assignee" htmlFor="marketing-task-assignee" required><select id="marketing-task-assignee" required value={form.assigneeId} onChange={event => set("assigneeId", event.target.value)}><option value="">Choose assignee</option>{users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select></Field>
          <Field label="Due" htmlFor="marketing-task-due"><Input id="marketing-task-due" type="datetime-local" value={form.dueAt} onChange={event => set("dueAt", event.target.value)}/></Field>
          <Field label="Priority" htmlFor="marketing-task-priority"><select id="marketing-task-priority" value={form.priority} onChange={event => set("priority", event.target.value)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></Field>
          <Field label="Notes" htmlFor="marketing-task-notes" className="marketing-field-wide"><Textarea id="marketing-task-notes" value={form.notes} onChange={event => set("notes", event.target.value)}/></Field>
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
