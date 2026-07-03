import { FileText, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { SKILL_FILE_MAX_BYTES, type SkillFileDto } from "@invisible-string/shared";

import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/forms";
import {
  useDeleteSkillFile,
  useUploadSkillFile,
} from "../../lib/queries/skills";
import type { ScopeRef } from "../../lib/queries/keys";
import { useToast } from "../ui/Toast";
import { Spinner } from "../ui/Spinner";

export interface AttachmentsSidebarProps {
  scope: ScopeRef;
  skillId: string;
  files: SkillFileDto[];
  readOnly: boolean;
}

const MAX_MIB = Math.floor(SKILL_FILE_MAX_BYTES / (1024 * 1024));

/** Text-format hint for the file picker (server enforces UTF-8-text with 415). */
const TEXT_ATTACHMENT_ACCEPT =
  "text/*,.md,.markdown,.txt,.json,.jsonc,.yaml,.yml,.toml,.csv,.tsv," +
  ".xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.sh,.rb,.go,.rs,.java,.sql,.env,.ini,.log";

export function AttachmentsSidebar({
  scope,
  skillId,
  files,
  readOnly,
}: AttachmentsSidebarProps) {
  const upload = useUploadSkillFile(scope);
  const remove = useDeleteSkillFile(scope);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    for (const file of Array.from(list)) {
      if (file.size > SKILL_FILE_MAX_BYTES) {
        toast({
          variant: "error",
          message: `${file.name} is larger than ${MAX_MIB} MiB.`,
        });
        continue;
      }
      try {
        await upload.mutateAsync({ skillId, file });
        toast({ variant: "success", message: `${file.name} attached.` });
      } catch (error) {
        toast({ variant: "error", message: errorMessage(error) });
      }
    }
  }

  return (
    <aside className="flex w-full flex-col gap-3 sm:w-64" aria-label="Attachments">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Attachments</h3>
        <span className="text-[12px] text-ink-4">{files.length}</span>
      </div>

      {!readOnly ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void handleFiles(event.dataTransfer.files);
          }}
          className={cn(
            "flex flex-col items-center gap-2 rounded-card-lg border border-dashed p-4 text-center transition-colors duration-150",
            dragging
              ? "border-ink/40 bg-black/[0.04]"
              : "border-black/15 bg-white/40",
          )}
        >
          <div className="flex size-9 items-center justify-center rounded-full bg-black/[0.05] text-ink-3">
            {upload.isPending ? <Spinner size={15} /> : <Upload size={16} aria-hidden="true" />}
          </div>
          <p className="text-[12px] leading-relaxed text-ink-3">
            Drop files here, or{" "}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="font-medium text-ink underline-offset-2 hover:underline"
            >
              browse
            </button>
          </p>
          <p className="text-[11px] text-ink-4">Up to {MAX_MIB} MiB each</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            // Reference files are packaged as text into the compiled skill —
            // hint text formats (the server rejects non-text with 415).
            accept={TEXT_ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(event) => {
              void handleFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
        </div>
      ) : null}

      {files.length === 0 ? (
        <p className="rounded-card border border-black/[0.06] bg-white/40 px-3 py-4 text-center text-[12px] text-ink-4">
          No files attached.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {files.map((file) => (
            <li
              key={file.name}
              className="flex items-center gap-2.5 rounded-card border border-black/[0.06] bg-white/50 px-3 py-2"
            >
              <FileText size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2" title={file.name}>
                {file.name}
              </span>
              {readOnly ? null : (
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() =>
                    remove.mutate(
                      { skillId, fileName: file.name },
                      {
                        onError: (error) =>
                          toast({ variant: "error", message: errorMessage(error) }),
                      },
                    )
                  }
                  className="lift flex size-7 shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-err/10 hover:text-err"
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
