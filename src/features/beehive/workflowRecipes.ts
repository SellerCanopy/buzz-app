import { PACKAGE_FILE, WORKFLOW_FILE, type Files } from "./workflowDraft";

/** The ways to begin a workflow that need no existing one. */
export const RECIPES = [
  {
    id: "engineering",
    title: "Engineering",
    description: "Research, plan, build, review and open a pull request.",
  },
  {
    id: "task",
    title: "Do a task",
    description: "An agent does the work and you review it.",
  },
  {
    id: "document",
    title: "Write a document",
    description: "An agent drafts a document and you approve it.",
  },
  {
    id: "blank",
    title: "Blank",
    description: "Start with one step and add your own.",
  },
] as const;

export type RecipeId = (typeof RECIPES)[number]["id"];

const TIMEOUT = { timeout: "30m" };

function prompt(agent: string, text: string, artifact?: string) {
  return {
    kind: "prompt",
    agent,
    prompt: `${text}\n\n# {{issue.title}}\n\n{{issue.body}}`,
    ...(artifact ? { outputs: [{ artifact }] } : {}),
    execution: TIMEOUT,
  };
}

function stagesOf(recipe: RecipeId, agent: string): unknown[] {
  switch (recipe) {
    case "engineering":
      return [
        {
          id: "research",
          name: "Research",
          ...prompt(
            agent,
            "Research how the code works today for this issue. Do not change any file. Save your findings with the Kiln tool save_artifact under the name research.",
            "research",
          ),
        },
        {
          id: "plan",
          name: "Plan",
          ...prompt(
            agent,
            "Write a plan for the change this issue asks for. Save it with the Kiln tool save_artifact under the name plan.",
            "plan",
          ),
        },
        {
          id: "plan_review",
          name: "Plan review",
          kind: "approval",
          approval: { artifacts: ["plan"] },
          on: { needs_work: "plan" },
          loop_limit: 3,
        },
        {
          id: "implement",
          name: "Implement",
          ...prompt(
            agent,
            "Make the change the approved plan describes on the branch {{branch}}, run the repository's checks, then commit and push.",
          ),
        },
        {
          id: "code_review",
          name: "Code review",
          ...prompt(
            agent,
            "Review the change on the branch {{branch}} against the plan. Save your findings with the Kiln tool save_artifact under the name review.",
            "review",
          ),
          on: { needs_work: "implement" },
          loop_limit: 3,
        },
        {
          id: "pull_request",
          name: "Pull request",
          kind: "action",
          action: "open_pull_request",
          with: { draft: "true" },
        },
      ];
    case "task":
      return [
        {
          id: "do",
          name: "Do",
          ...prompt(
            agent,
            "Do the work this card asks for. Save the result with the Kiln tool save_artifact under the name result.",
            "result",
          ),
        },
        {
          id: "review",
          name: "Review",
          kind: "approval",
          approval: { artifacts: ["result"] },
          on: { needs_work: "do" },
          loop_limit: 3,
        },
      ];
    case "document":
      return [
        {
          id: "draft",
          name: "Draft",
          ...prompt(
            agent,
            "Draft the document this card asks for. Save it with the Kiln tool save_artifact under the name document.",
            "document",
          ),
        },
        {
          id: "review",
          name: "Review",
          kind: "approval",
          approval: { artifacts: ["document"] },
          on: { needs_work: "draft" },
          loop_limit: 3,
        },
      ];
    case "blank":
      return [
        {
          id: "step",
          name: "Step",
          ...prompt(agent, "Describe the work this step does."),
        },
      ];
  }
}

/** The files of a new package for `recipe`, with every prompt stage run by `agent`. */
export function recipeFiles(
  recipe: RecipeId,
  name: string,
  agent: string,
): Files {
  return {
    [PACKAGE_FILE]: JSON.stringify({ name, version: "1.0.0" }, null, 2),
    [WORKFLOW_FILE]: JSON.stringify(
      { version: 2, stages: stagesOf(recipe, agent) },
      null,
      2,
    ),
  };
}
