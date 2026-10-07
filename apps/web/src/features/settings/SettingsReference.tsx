import { useTranslation } from "../../i18n";
export function SettingsReference() {
  const { t } = useTranslation();
  return (
    <ul className="settings-help">
      {[
        ["userGuide", "README.md"],
        ["selfHosting", "docs/self-hosting.md"],
        ["updateGuide", "docs/updating.md"],
      ].map(([key, path]) => (
        <li key={key}>
          <a
            href={`https://github.com/M0gician/intrica/blob/main/${path}`}
            target="_blank"
            rel="noreferrer"
          >
            {t(key!)}
          </a>
        </li>
      ))}
    </ul>
  );
}
