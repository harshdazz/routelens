# Send your first request

Open `.routelens/requests/first-request.req.json` and click **▶ Send request** at the top.

- **Server off?** RouteLens offers **▶ Start server**. It runs your `dev` script (or `start`) in a terminal you can see, waits up to 60 seconds, then sends the request again by itself. If the server crashes, RouteLens tells you and shows the terminal.
- **The answer** appears next to the button, like `✓ 200 OK · 14 ms`. Hover over it to preview the body, and click it to open the full response.

RouteLens only starts servers in trusted workspaces, and the first start always needs your click. The `routelens.autoStartServer` setting (`ask`, `always` or `never`) controls the starts after that.
