import type { MetaFunction } from "@remix-run/node";
import { Link } from "@remix-run/react";

export const meta: MetaFunction = () => {
  return [{ title: "About" }];
};

export default function About() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>About</h1>
      <p>This is a basic Remix app example for the Invisible Infrastructure project.</p>
      <p>
        Remix is a full-stack web framework that uses React for the UI and
        provides server-side rendering, data loading, and form handling out of
        the box.
      </p>
      <Link to="/">Back home</Link>
    </div>
  );
}
