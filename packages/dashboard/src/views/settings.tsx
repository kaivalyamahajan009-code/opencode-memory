import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import {
  createBackup,
  fetchBackups,
  fetchExport,
  forgetSession,
  patchConfig,
  redactTest,
  restoreBackup,
  setSessionFlags,
} from "../api"
import { errorMessage, FORGOTTEN_SESSION_TEXT, restoreErrorText, sessionFlagErrorText } from "../errors"
import { forgetOutcome } from "../forget-select"
import { downloadJson } from "../format"
import { baselineAfterSave, buildSettingsPatch, MIN_TIMER_MS, serverFieldError, type SettingsDraft } from "../settings-fields"
import { useDash } from "../store"
import type { MemoryConfigView } from "../types"
import { Banner, Button, Dialog, Field, LiveFeedback, TextArea, TextInput } from "../ui"

export default function Settings() {
  const dash = useDash()
  const cfg = () => dash.config()
  const [activation, setActivation] = createSignal("")
  const [buffer, setBuffer] = createSignal("")
  const [reflect, setReflect] = createSignal("")
  const [cap, setCap] = createSignal("")
  const [tokenCap, setTokenCap] = createSignal("")
  const [runnerKind, setRunnerKind] = createSignal("opencode-session")
  const [provider, setProvider] = createSignal("")
  const [model, setModel] = createSignal("")
  const [budgetSession, setBudgetSession] = createSignal("")
  const [budgetRecall, setBudgetRecall] = createSignal("")
  const [pruning, setPruning] = createSignal(false)
  const [keepTurns, setKeepTurns] = createSignal("")
  const [runnerTimeout, setRunnerTimeout] = createSignal("")
  const [reflectorTimeout, setReflectorTimeout] = createSignal("")
  const [lease, setLease] = createSignal("")
  const [saveError, setSaveError] = createSignal("")
  const [serverField, setServerField] = createSignal<{ key: string; text: string; raw: unknown } | undefined>()
  const [flagsError, setFlagsError] = createSignal("")
  const [redactIn, setRedactIn] = createSignal("")
  const [redactOut, setRedactOut] = createSignal("")
  const [backups, { refetch }] = createResource(() => fetchBackups())
  const [restoreFile, setRestoreFile] = createSignal<string | null>(null)
  const [restoreError, setRestoreError] = createSignal("")
  const [restoring, setRestoring] = createSignal(false)
  const [forgetOpen, setForgetOpen] = createSignal(false)
  const [forgetError, setForgetError] = createSignal("")
  const [seeded, setSeeded] = createSignal(false)
  const session = () => dash.host().sessionID
  const sessRow = () => dash.sessions().find((s) => s.id === session())
  const sessStatus = () => {
    const s = dash.status()?.session
    return s && s.sessionId === session() ? s : undefined
  }
  const excluded = () => sessStatus()?.excluded ?? !!sessRow()?.excluded
  const forgotten = () => !!sessStatus()?.forgotten

  const setFlag = async (flags: { paused?: boolean; excluded?: boolean }) => {
    setFlagsError("")
    try {
      await setSessionFlags(session(), flags)
      dash.toasts.ok("Session flags updated")
    } catch (e) {
      setFlagsError(sessionFlagErrorText(e))
    }
    await dash.reload()
  }

  const seedFrom = (c: MemoryConfigView) => {
    if (c.observe?.activationTokens != null) setActivation(String(c.observe.activationTokens))
    if (c.observe?.bufferTokens != null) setBuffer(String(c.observe.bufferTokens))
    if (c.reflect?.thresholdTokens != null) setReflect(String(c.reflect.thresholdTokens))
    if (c.cost?.dailyCapUsd != null) setCap(String(c.cost.dailyCapUsd))
    if (c.cost?.dailyTokenCap != null) setTokenCap(String(c.cost.dailyTokenCap))
    if (c.runner?.kind) setRunnerKind(c.runner.kind)
    if (c.runner?.model?.providerID) setProvider(c.runner.model.providerID)
    if (c.runner?.model?.modelID) setModel(c.runner.model.modelID)
    if (c.inject?.budget?.session != null) setBudgetSession(String(c.inject.budget.session))
    if (c.inject?.budget?.recall != null) setBudgetRecall(String(c.inject.budget.recall))
    if (c.pruning?.enabled != null) setPruning(!!c.pruning.enabled)
    if (c.pruning?.keepRecentTurns != null) setKeepTurns(String(c.pruning.keepRecentTurns))
    if (c.runner?.timeoutMs != null) setRunnerTimeout(String(c.runner.timeoutMs))
    setReflectorTimeout(c.reflectorRunner?.timeoutMs != null ? String(c.reflectorRunner.timeoutMs) : "")
    if (c.observe?.leaseMs != null) setLease(String(c.observe.leaseMs))
  }

  createEffect(() => {
    const c = cfg()
    if (!c || seeded()) return
    seedFrom(c)
    setSeeded(true)
  })

  const draft = (): SettingsDraft => ({
    activationTokens: activation(),
    bufferTokens: buffer(),
    reflectTokens: reflect(),
    dailyCapUsd: cap(),
    dailyTokenCap: tokenCap(),
    runnerKind: runnerKind(),
    providerID: provider(),
    modelID: model(),
    budgetSession: budgetSession(),
    budgetRecall: budgetRecall(),
    pruning: pruning(),
    keepRecentTurns: keepTurns(),
    ...(cfg()?.runner?.timeoutMs != null || runnerTimeout() ? { runnerTimeoutMs: runnerTimeout() } : {}),
    reflectorTimeoutMs: reflectorTimeout(),
    ...(cfg()?.observe?.leaseMs != null || lease() ? { leaseMs: lease() } : {}),
  })

  const parsed = createMemo(() => buildSettingsPatch(draft(), cfg()))
  const fieldError = (key: string) => {
    if (!seeded()) return ""
    const p = parsed()
    if (!p.ok) return p.errors[key] ?? ""
    const s = serverField()
    return s?.key === key && draftValue(key) === s.raw ? s.text : ""
  }
  const draftValue = (key: string) => (draft() as Record<string, unknown>)[key]
  const canSave = () => dash.configLoaded() && parsed().ok

  const save = async () => {
    const result = parsed()
    if (!dash.configLoaded()) {
      dash.toasts.error("Config has not loaded yet")
      return
    }
    if (!result.ok) return
    setSaveError("")
    if (!Object.keys(result.patch).length) {
      dash.toasts.ok("No changes")
      return
    }
    try {
      const returned = await patchConfig(result.patch)
      const baseline = baselineAfterSave(cfg(), returned, result.patch)
      dash.applyConfig(baseline)
      seedFrom(baseline)
      dash.toasts.ok("Config saved")
      await dash.reload()
    } catch (e) {
      const msg = errorMessage(e)
      setSaveError(`Config not saved: ${msg}`)
      const field = serverFieldError(msg)
      setServerField(field ? { ...field, raw: draftValue(field.key) } : undefined)
    }
  }

  const doRedact = async () => {
    try {
      const r = await redactTest(redactIn())
      setRedactOut(`${r.text}\n\n(${r.count} hits: ${(r.rules || []).join(", ") || "none"})`)
    } catch (e) {
      dash.toasts.error(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div class="max-w-xl space-y-5 p-4">
      <h1 class="text-[15px] font-semibold">Settings</h1>
      <Show when={dash.configError()}>
        <Banner>Could not load config: {dash.configError()}</Banner>
      </Show>
      <Show when={!dash.configLoaded()}>
        <Banner kind="warn">Config has not loaded. Save is disabled so defaults are not written.</Banner>
      </Show>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">Thresholds</h2>
        <NumField label="Activation tokens" value={activation()} onInput={setActivation} error={fieldError("activationTokens")} />
        <NumField label="Buffer tokens" value={buffer()} onInput={setBuffer} error={fieldError("bufferTokens")} />
        <NumField label="Reflect threshold" value={reflect()} onInput={setReflect} error={fieldError("reflectTokens")} />
      </section>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">Runner models</h2>
        <Field label="Runner kind">
          <select
            class="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            value={runnerKind()}
            aria-label="Runner kind"
            onChange={(e) => setRunnerKind(e.currentTarget.value)}
          >
            <option value="opencode-session">opencode-session</option>
            <option value="direct">direct</option>
          </select>
        </Field>
        <Field label="Provider ID">
          <TextInput label="Provider ID" value={provider()} onInput={setProvider} />
        </Field>
        <Field label="Model ID">
          <TextInput label="Model ID" value={model()} onInput={setModel} />
        </Field>
        <Show when={cfg()?.runner?.direct?.baseURL || cfg()?.runner?.direct?.apiKeyEnv}>
          <p class="text-[11px] text-neutral-500">
            Direct runner base URL (read-only): {cfg()?.runner?.direct?.baseURL || "—"}
            {cfg()?.runner?.direct?.apiKeyEnv ? ` · apiKeyEnv ${cfg()?.runner?.direct?.apiKeyEnv}` : ""}
          </p>
        </Show>
      </section>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">Injection budgets</h2>
        <NumField label="Session budget" value={budgetSession()} onInput={setBudgetSession} error={fieldError("budgetSession")} />
        <NumField label="Recall budget" value={budgetRecall()} onInput={setBudgetRecall} error={fieldError("budgetRecall")} />
      </section>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">Cost and pruning</h2>
        <NumField label="Daily cap (USD)" value={cap()} onInput={setCap} error={fieldError("dailyCapUsd")} />
        <NumField label="Daily token cap" value={tokenCap()} onInput={setTokenCap} error={fieldError("dailyTokenCap")} />
        <label class="flex items-center gap-2">
          <input type="checkbox" checked={pruning()} onChange={(e) => setPruning(e.currentTarget.checked)} />
          Enable pruning
        </label>
        <NumField label="Keep recent turns" value={keepTurns()} onInput={setKeepTurns} error={fieldError("keepRecentTurns")} />
      </section>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">Timers</h2>
        <p class="text-[11px] text-neutral-500">In milliseconds; each must be at least {MIN_TIMER_MS}.</p>
        <NumField label="Runner timeout (ms)" value={runnerTimeout()} onInput={setRunnerTimeout} error={fieldError("runnerTimeoutMs")} />
        <NumField
          label="Reflector timeout (ms)"
          value={reflectorTimeout()}
          onInput={setReflectorTimeout}
          error={fieldError("reflectorTimeoutMs")}
          placeholder="Same as runner"
        />
        <NumField label="Observation lease (ms)" value={lease()} onInput={setLease} error={fieldError("leaseMs")} />
        <LiveFeedback feedback={saveError() ? { tone: "error", text: saveError() } : undefined} />
        <Button kind="primary" onClick={() => void save()} disabled={!canSave()}>
          Save config
        </Button>
      </section>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">Server (read-only)</h2>
        <p class="text-[11px] text-neutral-500">Sensitive fields are not sent on save.</p>
        <p>Port: {cfg()?.port ?? "—"}</p>
        <p>Allowed origins: {(cfg()?.allowedOrigins ?? []).join(", ") || "—"}</p>
        <p>Data dir: {cfg()?.dataDir ?? "—"}</p>
        <p>Vault dir: {cfg()?.vaultDir ?? "—"}</p>
        <Show when={cfg()?.embeddings}>
          <p>
            Embeddings: {cfg()?.embeddings?.provider ?? "—"} {cfg()?.embeddings?.baseURL ?? ""}
          </p>
        </Show>
      </section>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">Redaction test</h2>
        <TextArea label="Redaction test input" value={redactIn()} onInput={setRedactIn} />
        <Button onClick={() => void doRedact()}>Test</Button>
        <Show when={redactOut()}>
          <pre class="whitespace-pre-wrap rounded bg-neutral-50 p-2 dark:bg-neutral-950">{redactOut()}</pre>
        </Show>
      </section>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">Backups</h2>
        <div class="flex gap-2">
          <Button
            onClick={async () => {
              try {
                const r = await createBackup()
                dash.toasts.ok(`Backup created: ${r.file}`)
                void refetch()
              } catch (e) {
                dash.toasts.error(e instanceof Error ? e.message : String(e))
              }
            }}
          >
            Create backup
          </Button>
          <Button
            onClick={async () => {
              try {
                const data = await fetchExport()
                downloadJson("memory-export.json", data)
              } catch (e) {
                dash.toasts.error(e instanceof Error ? e.message : String(e))
              }
            }}
          >
            Export JSON
          </Button>
        </div>
        <ul>
          <For each={backups.latest ?? []} fallback={<li class="text-neutral-500">No backups.</li>}>
            {(b) => (
              <li class="flex items-center justify-between py-1">
                <span>
                  {b.file} · {Math.round(b.size / 1024)} KB
                </span>
                <Button
                  onClick={() => {
                    setRestoreError("")
                    setRestoreFile(b.file)
                  }}
                >
                  Restore
                </Button>
              </li>
            )}
          </For>
        </ul>
      </section>
      <section class="space-y-2">
        <h2 class="text-[11px] font-semibold tracking-wide uppercase">This session</h2>
        <Show when={session()} fallback={<p class="text-neutral-500">No session in the URL.</p>}>
          <p class="truncate text-neutral-500">{session()}</p>
          <LiveFeedback feedback={flagsError() ? { tone: "error", text: flagsError() } : undefined} />
          <Show when={forgotten()}>
            <p class="text-neutral-500">{FORGOTTEN_SESSION_TEXT}</p>
          </Show>
          <div class="flex flex-wrap gap-2">
            <Button onClick={() => void setFlag({ paused: !sessRow()?.paused })}>{sessRow()?.paused ? "Resume session" : "Pause session"}</Button>
            <Show when={!(forgotten() && excluded())}>
              <Button onClick={() => void setFlag({ excluded: !excluded() })}>{excluded() ? "Include session" : "Exclude session"}</Button>
            </Show>
            <Button
              kind="danger"
              onClick={() => {
                setForgetError("")
                setForgetOpen(true)
              }}
            >
              Forget session
            </Button>
          </div>
        </Show>
      </section>
      <Dialog
        open={!!restoreFile()}
        title="Restore backup"
        onClose={() => setRestoreFile(null)}
        footer={
          <>
            <Button onClick={() => setRestoreFile(null)}>Cancel</Button>
            <Button
              kind="danger"
              disabled={restoring()}
              onClick={async () => {
                const file = restoreFile()
                if (!file || restoring()) return
                setRestoreError("")
                setRestoring(true)
                try {
                  await restoreBackup(file)
                  dash.toasts.ok("Backup restored")
                  setRestoreFile(null)
                  await dash.reload()
                } catch (e) {
                  setRestoreError(restoreErrorText(e))
                } finally {
                  setRestoring(false)
                }
              }}
            >
              Restore
            </Button>
          </>
        }
      >
        <LiveFeedback feedback={restoreError() ? { tone: "error", text: restoreError() } : undefined} />
        <p>Restore {restoreFile()}? This replaces the live memory database.</p>
      </Dialog>
      <Dialog
        open={forgetOpen()}
        title="Forget session"
        onClose={() => setForgetOpen(false)}
        footer={
          <>
            <Button onClick={() => setForgetOpen(false)}>Cancel</Button>
            <Button
              kind="danger"
              onClick={async () => {
                setForgetError("")
                try {
                  const result = await forgetSession(session())
                  dash.toasts.ok(forgetOutcome([], result).message)
                  setForgetOpen(false)
                  await dash.reload()
                } catch (e) {
                  setForgetError(errorMessage(e))
                }
              }}
            >
              Forget
            </Button>
          </>
        }
      >
        <LiveFeedback feedback={forgetError() ? { tone: "error", text: forgetError() } : undefined} />
        <p>This forgets observations for session {session()} and cannot be undone from the dashboard.</p>
      </Dialog>
    </div>
  )
}

function NumField(props: { label: string; value: string; onInput: (v: string) => void; error: string; placeholder?: string }) {
  return (
    <Field label={props.label}>
      <TextInput label={props.label} value={props.value} onInput={props.onInput} placeholder={props.placeholder} />
      <Show when={props.error}>
        <p class="text-red-700 dark:text-red-400">{props.error}</p>
      </Show>
    </Field>
  )
}
