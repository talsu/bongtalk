terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # TODO(task-010): configure S3 + DynamoDB backend per environment.
  # backend "s3" {
  #   bucket         = "qufox-tfstate"
  #   key            = "env/${var.env}/terraform.tfstate"
  #   region         = "ap-northeast-2"
  #   dynamodb_table = "qufox-tflock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project = "qufox"
      Env     = var.env
      Owner   = "platform"
    }
  }
}

# ---- VPC ----
# TODO(task-010): swap for terraform-aws-modules/vpc/aws
resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "qufox-${var.env}" }
}

# ---- RDS (Postgres 16) — skeleton ----
# TODO(task-010): use aws_db_subnet_group + aws_security_group + aws_db_instance
#                 pinned to pg16 with multi-az in prod, parameter group tuned.

# ---- ElastiCache Redis 7 — skeleton ----
# TODO(task-010): aws_elasticache_replication_group pinned to 7.x.

# ---- ECR ----
resource "aws_ecr_repository" "api" {
  name                 = "qufox-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_repository" "web" {
  name                 = "qufox-web"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}

output "ecr_api" { value = aws_ecr_repository.api.repository_url }
output "ecr_web" { value = aws_ecr_repository.web.repository_url }
