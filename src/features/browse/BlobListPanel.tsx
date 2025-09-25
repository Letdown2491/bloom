import React from "react";
import { BlobList, type BlobListProps } from "../../components/BlobList";

export const BlobListPanel: React.FC<BlobListProps> = props => {
  return <BlobList {...props} />;
};

export default BlobListPanel;
