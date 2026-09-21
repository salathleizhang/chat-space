import { LockKeyIcon } from "@phosphor-icons/react/LockKey";
import { useState, type FormEvent } from "react";
import { Button, Input, Panel } from "../shared/ui";
import { checkAccessGateAnswer, passAccessGate } from "../shared/storage/accessGate";

interface AccessGatePageProps {
  /** 答对并记住后调用，宿主随后渲染真正的站点 */
  onUnlock: () => void;
}

/** 访问门禁页：为了防止 API token 浪费，进入本产品前需要先回答一个问题。
    在 main.tsx 里挡在整个路由树之前，未解锁时不加载任何页面代码。 */
export function AccessGatePage({ onUnlock }: AccessGatePageProps) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!checkAccessGateAnswer(answer)) {
      setError("That's not correct. Please try again.");
      return;
    }
    passAccessGate();
    onUnlock();
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-6">
      <Panel className="w-full max-w-md animate-chrome-enter-center p-8">
        <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-fill">
          <LockKeyIcon size={22} className="text-ink-subtle" aria-hidden />
        </div>
        <h1 className="text-lg font-medium text-ink-strong">Answer a question to continue</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-subtle">
          To keep our API tokens from being wasted, this site is only open to people who know the
          answer. Get it right once and this browser stays unlocked.
        </p>
        <form className="mt-6" onSubmit={submit}>
          <label className="block text-sm text-ink" htmlFor="access-gate-answer">
            Which hackathon is this website built for?
          </label>
          <Input
            id="access-gate-answer"
            className="mt-2 w-full"
            size="lg"
            autoComplete="off"
            autoFocus
            placeholder="Enter the hackathon name"
            value={answer}
            aria-invalid={error !== null}
            onChange={(event) => {
              setAnswer(event.target.value);
              if (error !== null) setError(null);
            }}
          />
          {error !== null && (
            <p className="mt-2 text-xs text-signal" role="alert">
              {error}
            </p>
          )}
          <Button
            className="mt-4 w-full"
            type="submit"
            variant="primary"
            size="lg"
            disabled={answer.trim().length === 0}
          >
            Enter
          </Button>
        </form>
      </Panel>
    </div>
  );
}
