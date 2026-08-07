declare module "pa11y" {
  interface Pa11yIssue {
    code: string;
    message: string;
    selector: string;
    type: "error" | "warning" | "notice";
    context: string;
  }
  interface Pa11yResult {
    issues: Pa11yIssue[];
  }
  function pa11y(url: string, options?: Record<string, unknown>): Promise<Pa11yResult>;
  export default pa11y;
}
