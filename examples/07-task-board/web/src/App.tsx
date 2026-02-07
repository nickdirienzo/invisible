import { useEffect, useState } from "react";

interface Task {
  id: string;
  title: string;
  column: string;
  boardId: string;
  createdAt: string;
}

interface Board {
  id: string;
  name: string;
  createdAt: string;
}

const COLUMNS = ["todo", "in-progress", "done"] as const;

export function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newBoardName, setNewBoardName] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");

  useEffect(() => {
    fetch("/api/boards")
      .then((r) => r.json())
      .then(setBoards);
  }, []);

  useEffect(() => {
    if (!selectedBoard) return;
    fetch(`/api/boards/${selectedBoard}/tasks`)
      .then((r) => r.json())
      .then(setTasks);
  }, [selectedBoard]);

  async function createBoard() {
    if (!newBoardName.trim()) return;
    const res = await fetch("/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newBoardName }),
    });
    const board = await res.json();
    setBoards((prev) => [...prev, board]);
    setSelectedBoard(board.id);
    setNewBoardName("");
  }

  async function createTask() {
    if (!newTaskTitle.trim() || !selectedBoard) return;
    const res = await fetch(`/api/boards/${selectedBoard}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: newTaskTitle }),
    });
    const task = await res.json();
    setTasks((prev) => [...prev, task]);
    setNewTaskTitle("");
  }

  async function moveTask(taskId: string, column: string) {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column }),
    });
    const updated = await res.json();
    setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
  }

  async function deleteTask(taskId: string) {
    await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }

  return (
    <div style={{ fontFamily: "system-ui", maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <h1>Task Board</h1>

      <div style={{ marginBottom: 24 }}>
        <h2>Boards</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            value={newBoardName}
            onChange={(e) => setNewBoardName(e.target.value)}
            placeholder="New board name"
            onKeyDown={(e) => e.key === "Enter" && createBoard()}
          />
          <button onClick={createBoard}>Create Board</button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {boards.map((board) => (
            <button
              key={board.id}
              onClick={() => setSelectedBoard(board.id)}
              style={{
                fontWeight: selectedBoard === board.id ? "bold" : "normal",
                background: selectedBoard === board.id ? "#e0e0e0" : "white",
              }}
            >
              {board.name}
            </button>
          ))}
        </div>
      </div>

      {selectedBoard && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              placeholder="New task title"
              onKeyDown={(e) => e.key === "Enter" && createTask()}
            />
            <button onClick={createTask}>Add Task</button>
          </div>

          <div style={{ display: "flex", gap: 16 }}>
            {COLUMNS.map((column) => (
              <div
                key={column}
                style={{
                  flex: 1,
                  background: "#f5f5f5",
                  borderRadius: 8,
                  padding: 12,
                  minHeight: 200,
                }}
              >
                <h3 style={{ textTransform: "capitalize", marginTop: 0 }}>{column}</h3>
                {tasks
                  .filter((t) => t.column === column)
                  .map((task) => (
                    <div
                      key={task.id}
                      style={{
                        background: "white",
                        borderRadius: 4,
                        padding: 8,
                        marginBottom: 8,
                        boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                      }}
                    >
                      <div>{task.title}</div>
                      <div style={{ display: "flex", gap: 4, marginTop: 4, fontSize: 12 }}>
                        {COLUMNS.filter((c) => c !== column).map((c) => (
                          <button key={c} onClick={() => moveTask(task.id, c)} style={{ fontSize: 11 }}>
                            {c}
                          </button>
                        ))}
                        <button onClick={() => deleteTask(task.id)} style={{ fontSize: 11, color: "red" }}>
                          delete
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
