#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { TestimonialsStack } from "../lib/testimonials-stack";

const app = new cdk.App();

new TestimonialsStack(app, "TestimonialsStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "ap-southeast-2"
  }
});
