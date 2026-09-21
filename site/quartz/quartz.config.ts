// Quartz v5 (pin via QUARTZ_REF), Node >=22.
// PLACEHOLDER-VERIFY: this file is a minimal sketch written offline. Before use, diff it against
// the quartz.config.ts shipped in the pinned Quartz v5 tag (option names and plugin import paths
// can differ between versions) and adjust. Nothing here has been built or run.
import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

const config: QuartzConfig = {
  configuration: {
    pageTitle: "Brain",
    enableSPA: true,
    enablePopovers: true,
    analytics: null,
    locale: "en-US",
    baseUrl: "PLACEHOLDER-VERIFY.pages.dev", // owner: set to the real Pages domain
    // Private/noisy content is never published.
    ignorePatterns: [".obsidian", "Threads", "Gmail", "Inbox", "Meta", "Tasks/tasks.json", "Templates", "private"],
    defaultDateType: "modified",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: { header: "Schibsted Grotesk", body: "Source Sans Pro", code: "IBM Plex Mono" },
      colors: {
        lightMode: { light: "#faf8f8", lightgray: "#e5e5e5", gray: "#b8b8b8", darkgray: "#4e4e4e", dark: "#2b2b2b", secondary: "#284b63", tertiary: "#84a59d", highlight: "rgba(143, 159, 169, 0.15)" },
        darkMode: { light: "#161618", lightgray: "#393639", gray: "#646464", darkgray: "#d4d4d4", dark: "#ebebec", secondary: "#7b97aa", tertiary: "#84a59d", highlight: "rgba(143, 159, 169, 0.15)" },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({ priority: ["frontmatter", "filesystem"] }),
      Plugin.SyntaxHighlighting(),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }), // wikilinks
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({ enableSiteMap: true, enableRSS: false }), // powers graph + search
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.NotFoundPage(),
    ],
  },
}

export default config
