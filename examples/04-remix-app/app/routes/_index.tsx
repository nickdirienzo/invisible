import type { MetaFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";

export const meta: MetaFunction = () => {
  return [
    { title: "Remix Example" },
    { name: "description", content: "A basic Remix app example" },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  return json({
    message: "Welcome to Remix!",
    timestamp: new Date().toISOString(),
  });
}

export default function Index() {
  const data = useLoaderData<typeof loader>();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>{data.message}</h1>
      <p>Server time: {data.timestamp}</p>
      <nav>
        <ul>
          <li>
            <Link to="/about">About</Link>
          </li>
          <li>
            <Link to="/contacts">Contacts</Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}
