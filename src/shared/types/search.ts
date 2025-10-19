export type SearchSyntaxItem = {
  token: string;
  description: string;
};

export type SearchSyntaxSection = {
  id: string;
  title: string;
  items: SearchSyntaxItem[];
};
