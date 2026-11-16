import { useEffect, useState } from "react";
import { CaretLeftIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Header, InlineHeader } from "../../shared/design-system/ui/Header";
import { Input } from "../../shared/design-system/ui/Input";
import { Select } from "../../shared/design-system/ui/Select";
import { SurfaceButton } from "../../shared/design-system/ui/SurfaceButton";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type { AgentInfo, Workflow } from "./gen/kiln/engine/v1/engine_pb";
import { ImportWorkflowDialog } from "./ImportWorkflowDialog";
import { NAME_RULE, WORKFLOW_NAME } from "./routes";
import { RECIPES, recipeFiles, type RecipeId } from "./workflowRecipes";

/**
 * Adds a workflow: from a recipe, from a copy of one that exists, or from a zip. The name and
 * the agent that runs a recipe's agent tasks come first, because choosing a recipe saves the
 * workflow at once. The new workflow is the person's own and opens in the editor.
 */
export function NewWorkflowPage({
  client,
  isAdmin,
  me,
  onCreated,
  onClose,
}: {
  client: Client;
  isAdmin: boolean;
  /** The signed-in person's pubkey. */
  me: string;
  onCreated(name: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [source, setSource] = useState("");
  const [agents, setAgents] = useState<AgentInfo[]>();
  const [workflows, setWorkflows] = useState<Workflow[]>();
  const [nameError, setNameError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      client.listAgents(abort.signal),
      client.listWorkflows(abort.signal),
    ])
      .then(([listed, existing]) => {
        if (abort.signal.aborted) return;
        setAgents(listed.agents);
        setWorkflows(existing.workflows);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted) setError(errorMessage(failure));
      });
    return () => abort.abort();
  }, [client]);

  const mine = (agents ?? []).filter(
    (candidate) => isAdmin || candidate.ownerPubkey === me,
  );

  /** The name the person typed, or undefined after saying why it cannot be used. */
  const validName = () => {
    const trimmed = name.trim();
    if (!WORKFLOW_NAME.test(trimmed)) {
      setNameError(NAME_RULE);
      return undefined;
    }
    return trimmed;
  };

  const create = async (make: (name: string) => Promise<string>) => {
    if (pending) return;
    const trimmed = validName();
    if (!trimmed) return;
    setPending(true);
    setError(undefined);
    try {
      onCreated(await make(trimmed));
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  };

  const fromRecipe = (recipe: RecipeId) => {
    if (!validName()) return;
    if (!agent) {
      setError("Choose the agent that runs the agent tasks.");
      return;
    }
    void create(async (trimmed) => {
      const saved = await client.saveWorkflow(
        { name: trimmed, files: recipeFiles(recipe, trimmed, agent) },
        "",
      );
      return saved.workflow?.name ?? trimmed;
    });
  };

  const fromCopy = () => {
    if (!source) {
      setError("Choose a workflow to copy.");
      return;
    }
    void create(
      async (trimmed) => (await client.duplicateWorkflow(source, trimmed)).name,
    );
  };

  return (
    <div className="beehive-card-page">
      <div className="beehive-crumb">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to Workflows"
          onClick={onClose}
        >
          <CaretLeftIcon size="1rem" aria-hidden="true" />
          Workflows
        </Button>
      </div>
      <Header
        title="New workflow"
        subtitle="Name it, then pick how to begin."
        actions={
          <Button disabled={pending} onClick={onClose}>
            Cancel
          </Button>
        }
      />
      <div className="beehive-form wf-new-form">
        <Field
          label="Name"
          error={nameError}
          description="Cards and intake rules name the workflow by this."
        >
          <Input
            value={name}
            maxLength={32}
            disabled={pending}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setNameError(undefined);
            }}
          />
        </Field>
        <Select
          variant="field"
          label="Agent for the agent tasks"
          value={agent}
          disabled={pending || !agents}
          placeholder={mine.length ? "Choose an agent" : "No agent you can use"}
          groups={[
            {
              label: "Agents",
              options: mine.map((a) => ({ value: a.name, label: a.name })),
            },
          ]}
          onValueChange={(next) => {
            setAgent(next);
            setError(undefined);
          }}
        />
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
      <section className="beehive-workflow" aria-label="Start from a recipe">
        <InlineHeader
          title="Start from a recipe"
          actions={<span className="beehive-tag">Recommended</span>}
        />
        <ul className="wf-recipes">
          {RECIPES.map((recipe) => (
            <li key={recipe.id}>
              <SurfaceButton
                type="button"
                className="wf-recipe"
                disabled={pending}
                onClick={() => fromRecipe(recipe.id)}
              >
                <span className="text-label">{recipe.title}</span>
                <span className="text-body-sm text-subtle">
                  {recipe.description}
                </span>
              </SurfaceButton>
            </li>
          ))}
        </ul>
      </section>
      <section className="beehive-workflow" aria-label="Other ways to begin">
        <InlineHeader title="Other ways to begin" />
        <div className="wf-copy">
          <Select
            variant="field"
            label="Workflow to copy"
            value={source}
            disabled={pending || !workflows}
            placeholder="Choose a workflow"
            groups={[
              {
                label: "Workflows",
                options: (workflows ?? []).map((w) => ({
                  value: w.name,
                  label: w.name,
                })),
              },
            ]}
            onValueChange={(next) => {
              setSource(next);
              setError(undefined);
            }}
          />
          <Button disabled={pending} onClick={fromCopy}>
            Start from a copy
          </Button>
          <Button disabled={pending} onClick={() => setImporting(true)}>
            Import
          </Button>
        </div>
      </section>
      {importing && (
        <ImportWorkflowDialog
          client={client}
          onImported={(imported) => {
            setImporting(false);
            onCreated(imported);
          }}
          onClose={() => setImporting(false)}
        />
      )}
    </div>
  );
}
