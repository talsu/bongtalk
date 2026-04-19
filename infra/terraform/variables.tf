variable "env" {
  type        = string
  description = "dev | staging | prod"
}

variable "region" {
  type    = string
  default = "ap-northeast-2"
}
