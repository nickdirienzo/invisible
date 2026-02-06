import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, Link } from "@remix-run/react";

interface Contact {
  id: string;
  name: string;
  email: string;
}

const contacts: Contact[] = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
  { id: "3", name: "Charlie", email: "charlie@example.com" },
];

export const meta: MetaFunction = () => {
  return [{ title: "Contacts" }];
};

export async function loader() {
  return json({ contacts });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const name = formData.get("name") as string;
  const email = formData.get("email") as string;

  if (!name || !email) {
    return json({ error: "Name and email are required" }, { status: 400 });
  }

  const newContact: Contact = {
    id: String(contacts.length + 1),
    name,
    email,
  };
  contacts.push(newContact);

  return json({ success: true, contact: newContact });
}

export default function Contacts() {
  const { contacts } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>Contacts</h1>

      <ul>
        {contacts.map((contact) => (
          <li key={contact.id}>
            <strong>{contact.name}</strong> — {contact.email}
          </li>
        ))}
      </ul>

      <h2>Add Contact</h2>

      {actionData && "error" in actionData && (
        <p style={{ color: "red" }}>{actionData.error}</p>
      )}
      {actionData && "success" in actionData && (
        <p style={{ color: "green" }}>Added {actionData.contact.name}!</p>
      )}

      <Form method="post">
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Name: <input type="text" name="name" required />
          </label>
        </div>
        <div style={{ marginBottom: "0.5rem" }}>
          <label>
            Email: <input type="email" name="email" required />
          </label>
        </div>
        <button type="submit">Add</button>
      </Form>

      <br />
      <Link to="/">Back home</Link>
    </div>
  );
}
