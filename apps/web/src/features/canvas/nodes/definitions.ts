import type { ComponentType } from "react";
import { IconBrowser, IconGroup, IconImage, IconText } from "../../../components/icons";
import { tr } from "../../../i18n";
import type { NodePresentation } from "../../../utils/resource-view";

type NodeDefinition = {
  label: () => string;
  classes: readonly string[];
  icon: ComponentType<{ size?: number }>;
  inspectOnEnter: boolean;
};

export const nodeDefinitions: Record<NodePresentation["type"], NodeDefinition> = {
  text: { label: () => tr("文字"), classes: [], icon: IconText, inspectOnEnter: false },
  file: { label: () => tr("文字"), classes: [], icon: IconText, inspectOnEnter: true },
  image: {
    label: () => tr("图片"),
    classes: ["image-card"],
    icon: IconImage,
    inspectOnEnter: true,
  },
  pdf: {
    label: () => "PDF",
    classes: ["image-card", "pdf-card"],
    icon: IconText,
    inspectOnEnter: true,
  },
  group: { label: () => tr("容器"), classes: [], icon: IconGroup, inspectOnEnter: false },
  agent: { label: () => "Agent", classes: ["agent-card"], icon: IconGroup, inspectOnEnter: false },
  todo: { label: () => tr("待办"), classes: ["todo-card"], icon: IconText, inspectOnEnter: false },
  web: {
    label: () => tr("网页"),
    classes: ["bookmark-card"],
    icon: IconBrowser,
    inspectOnEnter: true,
  },
  directory: {
    label: () => tr("目录"),
    classes: ["directory-card"],
    icon: IconGroup,
    inspectOnEnter: true,
  },
  "path-image": {
    label: () => tr("图片"),
    classes: ["image-card", "path-image-card"],
    icon: IconImage,
    inspectOnEnter: true,
  },
  "path-pdf": {
    label: () => "PDF",
    classes: ["image-card", "pdf-card"],
    icon: IconText,
    inspectOnEnter: true,
  },
};
