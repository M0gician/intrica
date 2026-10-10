import { useState } from "react";
import { useContentLoad } from "../../components/useContentLoad";
import { tr } from "../../i18n";
import { Button } from "../../ui/button";

export function ReadMore({ load, version }: { load: () => Promise<void>; version: string }) {
  const [requested, setRequested] = useState(false);
  const state = useContentLoad(requested, load, version);
  return (
    <div className="record-load" aria-busy={state.loading}>
      {state.error && <p role="alert">{state.error}</p>}
      <Button
        disabled={state.loading}
        onClick={() => (state.error ? state.retry() : setRequested(true))}
      >
        {state.loading ? tr("加载完整内容…") : state.error ? tr("重试") : tr("阅读全文")}
      </Button>
    </div>
  );
}
