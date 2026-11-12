// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright 2026 Nikita Dovhich

export interface Routes {
    $schema?:     string;
    afterFiles?:  Rule[];
    beforeFiles?: Rule[];
    error?:       Error;
    fallback?:    Rule[];
    onMatch?:     Rule[];
    version:      number;
}

export interface Rule {
    action:    Action;
    continue?: boolean;
    id:        string;
    match:     Match;
}

export interface Action {
    append?:   { [key: string]: string };
    delete?:   string[];
    file?:     string;
    function?: string;
    location?: string;
    path?:     string;
    set?:      { [key: string]: string };
    status?:   number;
    type:      ActionType;
}

export type ActionType = "redirect" | "respond" | "rewrite" | "headers" | "middleware";

export interface Match {
    methods?: string[];
    path:     string;
    pathNot?: string;
}

export interface Error {
    "404"?: The404;
}

export interface The404 {
    file: string;
}
