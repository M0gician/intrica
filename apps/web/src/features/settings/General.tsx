import { useState } from "react";
import {
  type LanguagePreference,
  languagePreference,
  setLanguage,
  useTranslation,
} from "../../i18n";
import { Select } from "../../ui/field";
import { Notice, settingsError } from "./shared";

export function General() {
  const { t, i18n } = useTranslation();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <>
      <div className="settings-row">
        <div>
          <label htmlFor="language">{t("language")}</label>
        </div>
        <Select
          key={i18n.language}
          id="language"
          value={languagePreference()}
          onChange={async (event) => {
            try {
              await setLanguage(event.target.value as LanguagePreference);
              setError("");
              setSaved(true);
            } catch (error) {
              setError(settingsError(error));
            }
          }}
        >
          <option value="system">{t("system")}</option>
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </Select>
      </div>
      <Notice error={error} message={saved ? t("saved") : ""} />
    </>
  );
}
