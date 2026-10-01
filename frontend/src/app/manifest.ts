import type { MetadataRoute } from "next";

/**
 * The web app manifest (served at /manifest.webmanifest and linked from every
 * page by Next).
 *
 * Staff add the site to their iPad or phone home screen. Without a manifest,
 * iOS takes the app's scope from whatever page it was added from: added from a
 * roster page, the scope was /roster/, and every other screen counted as
 * leaving the app, so Safari dropped its address bar over the top. The scope
 * here is the whole site, and the app always starts from "/" (which sends each
 * person to their own landing page).
 *
 * iOS reads this once, when the icon is added: an existing home-screen icon
 * keeps its old scope until it is removed and added again.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Lantern Forms",
    short_name: "Forms",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfcfd",
    theme_color: "#fbfcfd",
    icons: [{ src: "/lcs_logo_color.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
