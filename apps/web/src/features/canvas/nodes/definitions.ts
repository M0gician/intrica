import type { ComponentType } from "react";
import { IconBrowser, IconGroup, IconImage, IconText } from "../../../components/icons";
import { tr } from "../../../i18n";
import type { NodePresentation } from "../../../utils/resource-view";

type NodeDefinition = {
  label: () => string;
  classes: readonly string[];
  icon: ComponentType<{ size?: number }>;
  inspectOnEnter: boolean;
  dragFromBody: boolean;
};

export const nodeDefinitions: Record<NodePresentation["type"], NodeDefinition> = {
  text: {
    label: () => tr("文字"),
    classes: [],
    icon: IconText,
    inspectOnEnter: false,
    dragFromBody: false,
  },
  file: {
    label: () => tr("文字"),
    classes: [],
    icon: IconText,
    inspectOnEnter: true,
    dragFromBody: false,
  },
  image: {
    label: () => tr("图片"),
    classes: ["image-card"],
    icon: IconImage,
    inspectOnEnter: true,
    dragFromBody: true,
  },
  pdf: {
    label: () => "PDF",
    classes: ["image-card", "pdf-card"],
    icon: IconText,
    inspectOnEnter: true,
    dragFromBody: true,
  },
  group: {
    label: () => tr("容器"),
    classes: [],
    icon: IconGroup,
    inspectOnEnter: false,
    dragFromBody: false,
  },
  agent: {
    label: () => "Agent",
    classes: ["agent-card"],
    icon: IconGroup,
    inspectOnEnter: false,
    dragFromBody: false,
  },
  todo: {
    label: () => tr("待办"),
    classes: ["todo-card"],
    icon: IconText,
    inspectOnEnter: false,
    dragFromBody: false,
  },
  web: {
    label: () => tr("网页"),
    classes: ["bookmark-card"],
    icon: IconBrowser,
    inspectOnEnter: true,
    dragFromBody: false,
  },
  directory: {
    label: () => tr("目录"),
    classes: ["directory-card"],
    icon: IconGroup,
    inspectOnEnter: true,
    dragFromBody: false,
  },
  "path-image": {
    label: () => tr("图片"),
    classes: ["image-card", "path-image-card"],
    icon: IconImage,
    inspectOnEnter: true,
    dragFromBody: true,
  },
  "path-pdf": {
    label: () => "PDF",
    classes: ["image-card", "pdf-card"],
    icon: IconText,
    inspectOnEnter: true,
    dragFromBody: true,
  },
};
