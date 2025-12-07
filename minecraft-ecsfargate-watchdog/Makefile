.PHONY: all run

TAG := 20251207-1
IMAGE := docker.io/braucher/minecraft-ecsfargate-watchdog
ECR_IMAGE := 621353950768.dkr.ecr.us-east-1.amazonaws.com/braucher/minecraft-ecsfargate-watchdog

build:
	docker buildx build --tag $(IMAGE):latest --tag $(IMAGE):$(TAG) --tag $(ECR_IMAGE):$(TAG) .

run: build
	docker run --init --rm -it $(IMAGE):$(TAG)

push: build
	aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 621353950768.dkr.ecr.us-east-1.amazonaws.com
	docker push $(ECR_IMAGE):$(TAG)
	docker push $(IMAGE):$(TAG)
	docker push $(IMAGE):latest

