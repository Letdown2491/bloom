import React from "react";
import { BlobList, type BlobListProps } from "./ui/BlobList";

export const BlobListPanel: React.FC<BlobListProps> = props => {
  return <BlobList {...props} />;
};
