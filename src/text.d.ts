// Markdown imported `with { type: "text" }` is bundled as its text.
declare module "*.md" {
  const text: string;
  export default text;
}
