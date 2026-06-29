import { Sandbox } from "@vercel/sandbox";

export const POST = async (event) => {
	const sandbox = await Sandbox.create({
		teamId: "test",
		token: "test",
		projectId: "test",
	});
	return new Response(JSON.stringify({ id: sandbox.id }));
};
