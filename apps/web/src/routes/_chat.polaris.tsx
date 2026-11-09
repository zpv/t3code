import { createFileRoute } from "@tanstack/react-router";
import { PolarisPage } from "../polaris/PolarisPage";
export const Route = createFileRoute("/_chat/polaris")({ component: PolarisPage });
