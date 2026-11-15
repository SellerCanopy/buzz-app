import { useEffect, useState } from "react";
import { PaperclipIcon } from "../../shared/design-system/icons";
import { Button } from "../../shared/design-system/ui/Button";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { Select } from "../../shared/design-system/ui/Select";
import { formatFileSize } from "../messages/FileAttachment";
import { useRelayConnection } from "../relay/react";
import type { RelayData } from "../relay/service";
import type { Client } from "./engine/client";
import { errorMessage } from "./engine/transport";
import type {
  ArtifactInfo,
  ArtifactVersion,
} from "./gen/kiln/engine/v1/engine_pb";

type Listing =
  | { status: "loading" }
  | { status: "ready"; artifacts: ArtifactInfo[] }
  | { status: "error"; message: string };

type Shown =
  | { status: "loading" }
  | { status: "ready"; version: ArtifactVersion }
  | { status: "error"; message: string };

/**
 * The documents and files a card's stages saved. Pick one by name, then a version (the newest
 * shows first). A document shows its text. A file shows its type and size with a download link.
 */
export function FilesTab({
  client,
  relay,
  cardId,
}: {
  client: Client;
  relay: RelayData;
  cardId: string;
}) {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState<string>();

  useEffect(() => {
    // `attempt` re-reads the list after a failure.
    void attempt;
    const abort = new AbortController();
    setListing({ status: "loading" });
    client
      .listArtifacts(cardId, abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        setListing({ status: "ready", artifacts: reply.artifacts });
        setName((current) =>
          reply.artifacts.some((a) => a.name === current)
            ? current
            : reply.artifacts[0]?.name,
        );
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setListing({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, cardId, attempt]);

  const artifacts = listing.status === "ready" ? listing.artifacts : [];
  return (
    <LoadingRegion
      pending={listing.status === "loading"}
      label="Loading files…"
      feedback={
        listing.status === "error" ? (
          <div className="beehive-error">
            <p role="alert" className="text-danger">
              {listing.message}
            </p>
            <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        ) : undefined
      }
    >
      {listing.status === "ready" && artifacts.length === 0 && (
        <EmptyState
          icon={<PaperclipIcon size="1.5rem" />}
          title="No files yet"
          description="Documents and files that stages save for each other show up here."
        />
      )}
      {name !== undefined && artifacts.length > 0 && (
        <div className="beehive-files">
          <Select
            label="File"
            variant="field"
            value={name}
            onValueChange={setName}
            groups={[
              {
                label: "Files",
                options: artifacts.map((a) => ({
                  value: a.name,
                  label: a.name,
                })),
              },
            ]}
          />
          <Artifact
            key={name}
            client={client}
            relay={relay}
            cardId={cardId}
            name={name}
          />
        </div>
      )}
    </LoadingRegion>
  );
}

/** One artifact: its versions to pick from and the chosen one. */
function Artifact({
  client,
  relay,
  cardId,
  name,
}: {
  client: Client;
  relay: RelayData;
  cardId: string;
  name: string;
}) {
  const [versions, setVersions] = useState<number[]>();
  const [picked, setPicked] = useState<number>();
  const [shown, setShown] = useState<Shown>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // `attempt` reads the versions again after a failure.
    void attempt;
    const abort = new AbortController();
    client
      .listArtifactVersions(cardId, name, abort.signal)
      .then((reply) => {
        if (abort.signal.aborted) return;
        const found = reply.versions.map((v) => v.version);
        setVersions(found);
        // Reading again after a failure must not move a person off the version they chose.
        setPicked((current) =>
          current !== undefined && found.includes(current)
            ? current
            : found[found.length - 1],
        );
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setShown({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, cardId, name, attempt]);

  useEffect(() => {
    // `attempt` reads the chosen version again after a failure.
    void attempt;
    if (picked === undefined) return;
    const abort = new AbortController();
    setShown({ status: "loading" });
    client
      .readArtifact(cardId, name, picked, abort.signal)
      .then((version) => {
        if (!abort.signal.aborted) setShown({ status: "ready", version });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setShown({ status: "error", message: errorMessage(error) });
      });
    return () => abort.abort();
  }, [client, cardId, name, picked, attempt]);

  return (
    <>
      {versions && versions.length > 1 && picked !== undefined && (
        <Select
          label="Version"
          variant="field"
          value={String(picked)}
          onValueChange={(next) => setPicked(Number(next))}
          groups={[
            {
              label: "Versions",
              options: [...versions].reverse().map((v) => ({
                value: String(v),
                label:
                  v === versions[versions.length - 1]
                    ? `${v} (latest)`
                    : `${v}`,
              })),
            },
          ]}
        />
      )}
      <LoadingRegion
        pending={shown.status === "loading"}
        label={`Loading ${name}…`}
        feedback={
          shown.status === "error" ? (
            <div className="beehive-error">
              <p role="alert" className="text-danger">
                {shown.message}
              </p>
              <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
            </div>
          ) : undefined
        }
      >
        {shown.status === "ready" && (
          <Body relay={relay} version={shown.version} />
        )}
      </LoadingRegion>
    </>
  );
}

function Body({
  relay,
  version,
}: {
  relay: RelayData;
  version: ArtifactVersion;
}) {
  const { session } = useRelayConnection(relay);
  if (version.kind !== "file")
    return (
      <section aria-label={version.name}>
        <pre className="beehive-file-text text-body-sm">{version.content}</pre>
      </section>
    );
  const source = session.media(version.mediaRef);
  const kind = version.mediaType || "File";
  return (
    <div className="beehive-file">
      <span>{version.name}</span>
      <span className="text-body-sm text-subtle">
        {kind} · {formatFileSize(Number(version.size))}
      </span>
      {source ? (
        <Button
          role="link"
          nativeButton={false}
          render={<a href={source} download={version.name} />}
        >
          Download
        </Button>
      ) : (
        <span className="text-body-sm text-subtle">
          This device cannot open the file here. Run{" "}
          <code>buzz media get {version.mediaRef} -o &lt;path&gt;</code> to save
          it.
        </span>
      )}
    </div>
  );
}
