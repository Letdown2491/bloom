import React from "react";
import { ShareComposer } from "../../components/ShareComposer";

type ShareComposerPanelProps = React.ComponentProps<typeof ShareComposer>;

export const ShareComposerPanel: React.FC<ShareComposerPanelProps> = props => {
  return <ShareComposer {...props} />;
};

export default ShareComposerPanel;
