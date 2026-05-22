"use client";

import type { DraggableAttributes, DraggableSyntheticListeners, UniqueIdentifier } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, ReactNode } from "react";

import { TableRow } from "@/components/ui/table";

type SortableTrProps = {
  id: UniqueIdentifier;
  children: (drag: { attributes: DraggableAttributes; listeners: DraggableSyntheticListeners }, isDragging: boolean) => ReactNode;
  className?: string;
};

/** 심플 summary 테이블용 드래그 가능한 <tr> */
export function SortableTr({ id, children, className }: SortableTrProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0.7, zIndex: 2, position: "relative" as const } : {}),
  };
  return (
    <tr ref={setNodeRef} style={style} className={className}>
      {children({ attributes, listeners }, isDragging)}
    </tr>
  );
}

export type SortableDragHandleProps = {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
};

type Props = {
  id: UniqueIdentifier;
  disabled?: boolean;
  className?: string;
  /** 드래그 핸들(⋮ 등)에만 listeners + attributes 를 붙이세요. */
  children: (drag: SortableDragHandleProps, isDragging: boolean) => ReactNode;
};

export function SortableBodyRow({ id, disabled, className, children }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { opacity: 0.88, zIndex: 2, position: "relative" as const } : {}),
  };
  return (
    <TableRow ref={setNodeRef} style={style} className={className}>
      {children({ attributes, listeners }, isDragging)}
    </TableRow>
  );
}

type StaticOrSortableProps = {
  manual: boolean;
  id: UniqueIdentifier;
  disabled?: boolean;
  className?: string;
  children: (drag: SortableDragHandleProps | null, isDragging: boolean) => ReactNode;
};

/** manual=false 일 때 일반 행(+ drag null); manual=true 일 때 드래그 가능한 행 */
export function SortableOrStaticTableRow({
  manual,
  id,
  disabled,
  className,
  children,
}: StaticOrSortableProps) {
  if (manual) {
    return (
      <SortableBodyRow id={id} disabled={disabled} className={className}>
        {(drag, isDragging) => children(drag, isDragging)}
      </SortableBodyRow>
    );
  }
  return <TableRow className={className}>{children(null, false)}</TableRow>;
}
