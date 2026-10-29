// The way back from a Connect button: the server sends the browser here with a code to finish with.
import { useEffect, useRef } from "react";
import type { useAction } from "../action";
import { errorText } from "../api";
import { navigate, useRoute } from "../router";

export function useSignInReturn(
  name: string,
  action: <T = unknown>(name: string, args?: unknown) => Promise<T>,
  running: boolean,
  { run, setError }: Pick<ReturnType<typeof useAction>, "run" | "setError">,
) {
  const route = useRoute();
  const finishing = useRef(false);
  const code = route.params.get("code");
  const state = route.params.get("state");
  const denied = route.params.get("error_description") ?? route.params.get("error");
  useEffect(() => {
    if (denied) {
      setError(`${name} said no: ${denied}`);
      navigate(route.path, true);
      return;
    }
    if (!code || !state || !running || finishing.current) return;
    finishing.current = true;
    void run(
      async () => {
        await action("finish", { code, state });
        navigate(route.path, true);
      },
      (err) => setError(errorText(err, "Couldn't connect.")),
    );
  }, [name, code, state, denied, running, action, run, setError, route.path]);
}
