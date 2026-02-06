export interface App {
  name: string;
  services: Service[];
}

export interface Service {
  name: string;
  build: string;
  port: number;
  entrypoint: string;
  typescript: boolean;
  ingress?: IngressRule[];
  scale?: ScaleBounds;
  env?: Record<string, string>;
}

export interface IngressRule {
  host: string;
  path?: string;
}

export interface ScaleBounds {
  min: number;
  max: number;
}
