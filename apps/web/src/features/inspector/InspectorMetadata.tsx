import type { Edge, Node } from "@intrica/contracts";
import type { InspectorPanelProps } from "../../components/InspectorPanel";
import { IconDelete } from "../../components/icons";
import { tr, useTranslation } from "../../i18n";
import { Button } from "../../ui/button";
import { nodeDisplayTitle } from "../../utils/graph";
import { OPERATION_LABELS, STATUS_LABELS } from "../../utils/labels";

type RelationItem = {
  edgeId: string;
  nodeId: string;
  title: string;
};
function relationLists(
  node: Node,
  nodes: ReadonlyMap<string, Node>,
  edges: ReadonlyMap<string, Edge>,
) {
  const result: {
    derivedFrom: RelationItem[];
    referencedBy: RelationItem[];
    links: RelationItem[];
  } = { derivedFrom: [], referencedBy: [], links: [] };
  const titleOf = (id: string) => {
    const target = nodes.get(id);
    return target ? nodeDisplayTitle(target) : id;
  };
  for (const edge of edges.values()) {
    if (edge.type === "derived_from" && edge.from === node.id)
      result.derivedFrom.push({ edgeId: edge.id, nodeId: edge.to, title: titleOf(edge.to) });
    else if (edge.type === "derived_from" && edge.to === node.id)
      result.referencedBy.push({ edgeId: edge.id, nodeId: edge.from, title: titleOf(edge.from) });
    else if (edge.type === "user_link" && (edge.from === node.id || edge.to === node.id)) {
      const id = edge.from === node.id ? edge.to : edge.from;
      result.links.push({ edgeId: edge.id, nodeId: id, title: titleOf(id) });
    }
  }
  return result;
}
function RelationList({
  title,
  items,
  onSelectNode,
  onDelete,
}: {
  title: string;
  items: RelationItem[];
  onSelectNode: (id: string) => void;
  onDelete?: (edgeId: string) => void;
}) {
  useTranslation();

  return (
    <section className="inspector-relations" aria-label={title}>
      <h2>{title}</h2>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.edgeId}>
              <Button type="button" onClick={() => onSelectNode(item.nodeId)}>
                {item.title}
              </Button>
              {onDelete && (
                <Button
                  type="button"
                  className="relation-delete"
                  aria-label={tr("删除与{{v0}}的连接", { v0: item.title })}
                  onClick={() => onDelete(item.edgeId)}
                >
                  <IconDelete size={13} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="inspector-empty">{tr("无")}</p>
      )}
    </section>
  );
}
export function InspectorMetadata(props: InspectorPanelProps) {
  useTranslation();
  const { node } = props;
  const relations = relationLists(node, props.nodes, props.edges);
  const deleteRelation = (edgeId: string) => {
    const edge = props.edges.get(edgeId);
    if (edge) props.onDeleteEdge?.(edge);
  };
  const children = node.childOrder
    .map((id) => props.nodes.get(id))
    .filter((value): value is Node => Boolean(value));
  const relatedOperations = [...props.operations.values()].filter(
    (op) =>
      op.selection.includes(node.id) ||
      op.outputIds.includes(node.id) ||
      op.resultContainerId === node.id,
  );
  return (
    <>
      {relations.derivedFrom.length + relations.referencedBy.length + relations.links.length >
        0 && (
        <details className="detail-meta">
          <summary>
            {tr("关系与来源（")}
            {relations.derivedFrom.length + relations.referencedBy.length + relations.links.length}
            ）
          </summary>
          <RelationList
            {...(props.onDeleteEdge ? { onDelete: deleteRelation } : {})}
            title={tr("派生自")}
            items={relations.derivedFrom}
            onSelectNode={props.onSelectNode}
          />
          <RelationList
            {...(props.onDeleteEdge ? { onDelete: deleteRelation } : {})}
            title={tr("被引用")}
            items={relations.referencedBy}
            onSelectNode={props.onSelectNode}
          />
          <RelationList
            title={tr("连接")}
            items={relations.links}
            onSelectNode={props.onSelectNode}
          />
        </details>
      )}
      {children.length > 0 && (
        <details className="detail-meta">
          <summary>
            {tr("子节点（")}
            {children.length}）
          </summary>
          <section aria-label={tr("子节点")}>
            <h2 className="sr-only">{tr("子节点")}</h2>
            <ul>
              {children.map((child) => (
                <li key={child.id}>
                  <Button type="button" onClick={() => props.onSelectNode(child.id)}>
                    {nodeDisplayTitle(child)}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </details>
      )}
      {relatedOperations.length > 0 && (
        <details className="detail-meta">
          <summary>
            {tr("最近操作（")}
            {relatedOperations.length}）
          </summary>
          <section aria-label={tr("最近操作")}>
            <h2 className="sr-only">{tr("最近操作")}</h2>
            <ul>
              {relatedOperations.map((op) => (
                <li key={op.id}>
                  {OPERATION_LABELS[op.type]} · {STATUS_LABELS[op.status]}
                </li>
              ))}
            </ul>
          </section>
        </details>
      )}
    </>
  );
}
