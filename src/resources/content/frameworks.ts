import type { DocResource } from '../index.js';

/**
 * Documentation resource with per-runtime deployment guidance for all
 * supported languages (Node.js, Deno, Python, Go, Rust, Ruby, Elixir, PHP,
 * JVM, .NET, C++) plus static sites.
 */
export const resources: DocResource[] = [
  {
    name: 'Framework & runtime guides',
    uri: 'partiri://docs/frameworks/runtimes',
    description:
      'Per-runtime deployment guides for all 12 supported languages and static sites',
    content: `# Framework & Runtime Guides

## Node.js

Deploy Node.js applications using any framework. Partiri supports Node.js with automatic detection from \`package.json\`. Set your build and run commands, and we handle the rest.

## Deno

Deploy Deno applications using the native \`Deno.serve\` API or frameworks like Oak. Partiri detects Deno projects from \`deno.json\` or \`deno.jsonc\`. Cache dependencies at build time with \`deno cache\` and run with the permissions your app needs (e.g. \`deno run --allow-net --allow-env\`).

## Python

Deploy Python web applications with any WSGI or ASGI framework. Partiri detects Python projects from \`requirements.txt\` or \`pyproject.toml\` and runs your app with the server of your choice.

## Go

Deploy Go applications compiled to a single binary. Partiri detects Go projects from \`go.mod\`. Build produces a static binary that runs efficiently with minimal resource usage.

## Rust

Deploy Rust web services compiled with cargo. Partiri detects Rust projects from \`Cargo.toml\`. The release build produces a high-performance binary with minimal memory footprint.

## Ruby

Deploy Ruby applications and Rails projects. Partiri detects Ruby from your \`Gemfile\` and supports Puma, Unicorn, or any Rack-compatible server.

## Elixir

Deploy Elixir and Phoenix applications. Partiri detects Elixir projects from \`mix.exs\` and supports OTP releases for production deployments.

## PHP

Deploy PHP applications including Laravel and other frameworks. Partiri detects PHP from \`composer.json\` and supports both built-in server and custom configurations.

## JVM (Java/Kotlin)

Deploy Java and Kotlin applications using Spring Boot, Quarkus, or any JVM framework. Partiri detects JVM projects from \`build.gradle\` or \`pom.xml\`.

## .NET

Deploy ASP.NET Core and other .NET applications. Partiri detects .NET projects from \`.csproj\` or \`.fsproj\` files and supports the dotnet CLI for builds.

## C++

Deploy C++ web services built with CMake. Partiri detects C++ projects from \`CMakeLists.txt\` and supports frameworks like Crow for HTTP serving.

## Static Sites

Deploy static HTML, CSS, and JavaScript sites. Partiri serves static content using Caddy with automatic HTTPS. No build step required for plain static files.`,
  },
];
