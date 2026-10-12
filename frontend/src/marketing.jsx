import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, EmptyState, Tabs, TabsList, TabsTrigger } from "@/ui";
import { Icon } from "./icons.jsx";
import { loadMarketingWorkspace } from "./data.js";

const VIEW_LABELS = {
  pipeline: "Pipeline",
  list: "Opportunity list",
  insights: "Insights",
};

function updateMarketingUrl(view, opportunityId) {
  const params = new URLSearchParams(window.location.search);
  params.set("tab", "marketing");
  params.set("view", view);
  if (opportunityId) params.set("opportunity", opportunityId);
  else params.delete("opportunity");
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

export function MarketingPage({
  access,
  users = [],
  clients = [],
  currentUser = null,
  initialView = "pipeline",
  initialOpportunityId = null,
}) {
  const visibleViews = useMemo(
    () => access.visibleChildren("page.marketing").filter(node => node.view),
    [access]
  );
  const allowedNames = useMemo(() => visibleViews.map(node => node.view), [visibleViews]);
  const safeInitialView = allowedNames.includes(initialView) ? initialView : (allowedNames[0] || "pipeline");
  const [view, setView] = useState(safeInitialView);
  const [workspace, setWorkspace] = useState(null);
  const [selectedId, setSelectedId] = useState(initialOpportunityId);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const next = await loadMarketingWorkspace();
      setWorkspace(next);
      setStatus("ready");
    } catch (loadError) {
      setError(loadError);
      setStatus("error");
    }
  }, []);

  useEffect(() => { load(); }, [load, reloadKey]);

  useEffect(() => {
    if (!allowedNames.length) return;
    if (!allowedNames.includes(view)) setView(allowedNames[0]);
  }, [allowedNames, view]);

  useEffect(() => {
    if (status !== "ready") return;
    const allRows = [...(workspace?.opportunities || []), ...(workspace?.archivedOpportunities || [])];
    if (selectedId && !allRows.some(row => row.id === selectedId)) setSelectedId(null);
  }, [selectedId, status, workspace]);

  useEffect(() => {
    if (!allowedNames.includes(view)) return;
    updateMarketingUrl(view, selectedId);
  }, [allowedNames, selectedId, view]);

  if (status === "loading") {
    return (
      <div className="marketing-state" role="status" aria-live="polite">
        <Icon name="spinner" className="animate-spin"/> Loading Marketing…
      </div>
    );
  }

  if (status === "error") {
    return (
      <Alert tone="danger" title="Marketing could not load" icon={<Icon name="warn"/>}>
        <p>{error?.message || "Please try again."}</p>
        <Button size="sm" variant="default" onClick={() => setReloadKey(key => key + 1)}>
          <Icon name="refresh"/> Retry
        </Button>
      </Alert>
    );
  }

  const opportunities = workspace?.opportunities || [];
  const selected = [...opportunities, ...(workspace?.archivedOpportunities || [])]
    .find(row => row.id === selectedId) || null;

  return (
    <section className="marketing-page" aria-label="Marketing workspace"
      data-user-count={users.length} data-client-count={clients.length} data-current-user={currentUser?.id || undefined}>
      {visibleViews.length > 1 && (
        <Tabs value={view} onValueChange={setView}>
          <TabsList variant="underline" className="bx-page-tabs" aria-label="Marketing views">
            {visibleViews.map(node => (
              <TabsTrigger key={node.key} value={node.view}>{VIEW_LABELS[node.view] || node.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {!opportunities.length ? (
        <EmptyState
          iconName="marketing"
          title="Build your first Marketing opportunity"
          hint="Track the relationship from introduction through a signed or lost contract."
        />
      ) : (
        <div className="marketing-shell-view" data-view={view}>
          <header>
            <h2>{VIEW_LABELS[view]}</h2>
            <p>{opportunities.length} active opportunit{opportunities.length === 1 ? "y" : "ies"}</p>
          </header>
          {selected && (
            <Alert tone="info" title={selected.title}>
              Deep-linked opportunity ready to open in the detail workspace.
            </Alert>
          )}
        </div>
      )}
    </section>
  );
}

export default MarketingPage;
