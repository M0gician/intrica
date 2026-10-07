import type { ApiError } from "@intrica/client";
import i18n from "./index";
export function errorMessage(error: ApiError) {
  if (error.code === "DISCOVERY_FAILED" && error.upstreamStatus !== undefined)
    return i18n.t(
      [401, 403].includes(error.upstreamStatus) ? "modelListUnauthorized" : "modelListHttpError",
      { status: error.upstreamStatus },
    );
  return i18n.t(`error_${error.code}`, {
    defaultValue: i18n.t("requestError", { code: error.code, status: error.status }),
  });
}
